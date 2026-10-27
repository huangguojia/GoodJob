/**
 * 通话转写（本机 whisper.cpp）。
 *
 * 为什么放在插件进程里而不是扩展里：
 *   - MV3 的 service worker 会休眠，录音/推理这种长任务放进去必然被掐；
 *   - 扩展里跑 WASM 版 whisper 在 M1 上只有 0.3~0.5 倍实时，跟不上对话；
 *   - 插件已经是常驻 Node 进程，把一个 `whisper-server` 拉起来常驻，每次只付推理时间
 *     （模型只加载一次），这才是「说完 1 秒内出字」的前提。
 *
 * 音频**不出本机**：扩展 → 本机 127.0.0.1:3100 → 本机 whisper-server。没有云端调用。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** whisper-server 的默认端口。避开 3100（插件自己）、3111（e2e 插件）。 */
const DEFAULT_PORT = 3110;
const START_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * 让 whisper 输出**简体**中文的偏置句。
 *
 * 不加这句时，whisper 的 small 模型对普通话默认吐繁体（实测「確認 / 時間」）。
 * whisper.cpp 官方推荐的做法就是给 `--prompt 以下是普通话的句子。`，实测有效。
 *
 * ⚠️ 这句**不能无脑全语种带上**：实测西语音频 + 中文 prompt，模型会在开头凭空
 * 多出一句 "En la primera vez,"（prompt 被当成上一句上下文续写）。所以只在
 * 已经确认是中文的第二次请求里才带（见 `transcribe()`）。
 */
const SIMPLIFIED_ZH_PROMPT = "以下是普通话的句子。";

/**
 * 业务热词（initial prompt）。
 *
 * 为什么必须给：whisper 的 small 模型对**专有名词和行业缩写**几乎没有先验，
 * 一段话里错的全是这些词 —— 实测把 MOQ 听成 mock / MOP、把「FOB 深圳」听成
 * 「Fab Shenzhen / FOP 深圳」、把「二十尺柜」听成「20 尺贵」。
 *
 * 这些词在句子里只占几个字，却决定了整句能不能用（报价单里 policy 和 price 差一个字
 * 就是两件事）。prompt 相当于把这些词临时塞进解码器的上下文，实测效果非常大：
 *   · 中文外贸句 CER 从 29.8% → 11.5%；带 HS/MOQ/柜型那句从 10.8% → 0.0%
 *   · 英文句 WER 从 16.1% → 6.5%（MOQ 一次就对了）
 *
 * ⚠️ 写法上踩过的三个坑（都实测过，别改回去）：
 *   1. **词表式不如例句式**。罗列三十个术语反而把模型带回繁体，FOB 也照样听成 FOP；
 *      写成「我们报 FOB 深圳价。FOB 深圳。MOQ 是多少？」就全对了 —— 模型对
 *      「一句话里的词」比「一张清单里的词」敏感得多。
 *   2. **同一句里给一次不够，要重复一次**。只出现一遍时 FOB 仍会变成 FOP/Fab。
 *   3. **别塞具体数字**。prompt 里写「一千二百美元、三十五天」时，输出会被拉成
 *      中文数字写法；换成不带金额的例句后，数字仍按音频原样输出。
 *
 * ⚠️ 两条铁律（也是实测踩出来的）：
 *   · **prompt 必须跟识别语种一致**。中文 prompt 配西语音频，模型会在开头凭空
 *     续写一句 "En la primera vez," —— prompt 被当成上一句上下文了。
 *   · 所以 `auto` 一律**不带** prompt：不知道语种时带任何一门语言的 prompt 都是赌。
 */
const BUSINESS_PROMPT_ZH =
  "以下是普通话的句子。我们报 FOB 深圳价。FOB 深圳。MOQ 是多少？HS 编码。" +
  "二十尺柜、四十尺高柜、交货期、单价、样品、定金、尾款。";

const BUSINESS_PROMPT_EN =
  "Business call about quotations. We quote FOB Shenzhen. FOB Shenzhen. What is your MOQ? " +
  "HS code. 20 foot container, 40 foot HQ, lead time, unit price, sample, deposit, balance.";

/**
 * 按语种挑 prompt。`auto` / 其他语种返回空串 —— 见上面第 2 条铁律。
 * 中文的 prompt 顺带把繁简偏置带上：small 模型对普通话默认吐繁体，这句话能压住大半。
 */
export function promptForLanguage(language: string | undefined): string {
  const value = String(language ?? "").toLowerCase();
  if (value === "zh" || value === "chinese" || value.startsWith("zh-")) {
    return `${SIMPLIFIED_ZH_PROMPT}${BUSINESS_PROMPT_ZH}`;
  }
  if (value === "en" || value === "english" || value.startsWith("en-")) return BUSINESS_PROMPT_EN;
  return "";
}

/**
 * 繁体专用字（极小集合，只收业务对话里高频、且简体形态一定不同的字）。
 * 用途只有一个：判断第一次中文结果要不要补跑一次简体化——命中就补，
 * 误判的代价只是多跑一次、结果不变，所以宁可宽松。
 * 注意别混进简体同形字（迎 / 境 / 幕 / 池 / 示 / 甚），否则等于每次都补跑。
 */
const TRADITIONAL_ZH_CHARS =
  "這個們妳與麼說請問題幫謝時間為對於後來價錢產張開關係應該讓給過還沒樣幾華語費運單據發貨艙櫃裝訂" +
  "數詢確認聯絡電話郵遞總額稅銀轉帳賬戶條規標準備齊檢測質優廠隻圓幣萬億噸體積寬長顏範圍數據庫統" +
  "報圖檔資訊軟網設鍵盤顯螢電續週裡傳遞閱覽簽約顧專從級頁號碼稱貼塊";
const TRADITIONAL_ZH = new RegExp(`[${[...new Set(TRADITIONAL_ZH_CHARS)].join("")}]`);

function isChinese(language: string | undefined): boolean {
  const value = String(language ?? "").toLowerCase();
  return value === "zh" || value === "chinese" || value.startsWith("zh-");
}

function isEnglish(language: string | undefined): boolean {
  const value = String(language ?? "").toLowerCase();
  return value === "en" || value === "english" || value.startsWith("en-");
}

/**
 * 用**转写出来的字**复核 whisper 自报的语种，只在中文/英文之间纠偏。
 *
 * 为什么需要它：whisper 的自动语种判定看的是第一段声学特征，**短句几乎没有特征**。
 * 通话里最典型的一句「喂，你好」只有 0.6 秒，被判成 `en` 是常事 —— 一旦判成 en，
 * 第二遍就会带着英文 prompt 按英文解码，中文整段变成拼音/谐音（实测 WER 88% 那种）。
 *
 * 判据只看字形，不看概率（whisper.cpp 的 server 不回语言概率）：
 *   · 自称英文、但正文里**汉字 ≥2 个且不少于拉丁词数** → 判为中文。
 *     「我们报 FOB 深圳价」这种中英混说也算中文（汉字 6 > 拉丁词 1）。
 *   · 自称中文、但正文一个汉字都没有且拉丁词 ≥3 → 判为英文（误判反方向，少见但便宜）。
 *   · 自称日语/韩语等：**不动**。汉字在日文里同样密集，硬纠会把日语整段拉成中文；
 *     而这两门语种本来就不在「主要中英」的范围里，保持原判定更安全。
 *
 * 一个汉字都不出现的纯英文句（`What is your MOQ`）天然不会被改动。
 */
export function refineLanguage(detected: string, text: string): string {
  const value = String(detected ?? "").toLowerCase();
  const body = String(text ?? "");
  if (!body.trim()) return value;

  const han = (body.match(/\p{Script=Han}/gu) || []).length;
  const latinWords = (body.match(/[A-Za-z][A-Za-z'’-]*/gu) || []).length;
  // 出现假名/谚文时说明确实不是中文，不纠
  const nonHanCjk = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(body);

  if (isEnglish(value) && !nonHanCjk && han >= 2 && han >= latinWords) return "zh";
  if (isChinese(value) && han === 0 && latinWords >= 3) return "en";
  return value;
}

/**
 * 这段结果要不要补跑一次"简体化"。
 *
 * 判据是「识别语种是中文」**且**「文本里出现了繁体专用字」。
 * 抽查一项都不满足就不补：
 *   - 西语/英语等拉丁语系永远不补（它们根本不会命中字符集），一次请求就够；
 *   - 已经是简体也不补 —— 否则每句中文都要多花 0.5~0.9 秒。
 */
export function needsSimplifiedZh(text: string, language: string | undefined): boolean {
  return isChinese(language) && TRADITIONAL_ZH.test(String(text ?? ""));
}

/**
 * whisper 在**静音 / 纯噪声 / 语种被指定错**时，会吐三种固定形态的垃圾：
 *
 *   1. 非语音标记：`[BLANK_AUDIO]`、`[MUSIC]`、`(speaking in foreign language)`；
 *   2. 同一词反复念：`Wait wait wait wait wait wait`、`等等等等等等等`；
 *   3. 有音无字的乱码（这条没法用规则判，交给能量门限与语言设置）。
 *
 * 这些不是"识别错了"，而是模型在说"这段我没有内容"。把它们当正文送进面板，
 * 用户看到的是"空白音频""等等等等"这种鬼话，还会被当成译文去翻译 ——
 * 既然原文本来就没有内容，正确做法是**让它不出现**。
 *
 * 重复词阈值取 6：whisper 的复读幻觉通常 7~10 次起步，而人真的连说 6 次
 * 「no no no no no no」在业务对话里几乎不会发生；宁可漏掉一句，也不要把
 * 满屏"等等等等"留在客户面前。
 */
const NON_SPEECH_MARKER = /^(?:\[[^\]]{0,40}\]|\([^)]{0,40}\)|（[^）]{0,40}）)$/u;
/**
 * 复读要**不区分大小写**：whisper 的典型产物是「Wait wait wait wait」（首词大写、后面小写），
 * 区分大小写时一个都匹配不到 —— 这条已经踩过一次，别去掉 `i`。
 */
const REPEATED_WORD = /^([\p{L}\p{N}'’-]{1,12})(?:[\s,，.。!！?？…、-]+\1){5,}[\s.。!！?？…、-]*$/iu;

/** 清洗一段转写结果：只删掉"明确没有内容"的产物，正文一个字都不改。 */
export function cleanTranscript(text: string): string {
  const value = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (!value) return "";
  if (NON_SPEECH_MARKER.test(value)) return "";
  if (REPEATED_WORD.test(value)) return "";
  return value;
}

export interface CallTranscribeStatus {
  available: boolean;
  running: boolean;
  model: string;
  modelPath: string;
  reason: string;
}

function firstExisting(candidates: string[]): string {
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? "";
}

/** `whisper-server` 的候选路径：本项目自建目录优先，其次 Homebrew（Apple Silicon / Intel）。 */
function resolveBinary(): string {
  const explicit = String(process.env.WHISPER_SERVER_BIN ?? "").trim();
  if (explicit) return explicit;
  return firstExisting([
    path.join(os.homedir(), ".goodjob-whisper", "bin", "whisper-server"),
    "/opt/homebrew/bin/whisper-server",
    "/usr/local/bin/whisper-server"
  ]);
}

/**
 * 模型候选：环境变量优先，其次用户目录下我们自己的缓存目录。
 * 选 `small` 作为默认：M1 上约 10 倍实时（30 秒音频 ≈ 3 秒），中英都够用；
 * `base` 快一倍但带口音的英语掉字明显，`medium` 在这台 16G 的机器上没有实时余量。
 */
function resolveModel(): { name: string; modelPath: string } {
  const explicit = String(process.env.WHISPER_MODEL_PATH ?? "").trim();
  if (explicit) return { name: path.basename(explicit).replace(/^ggml-|\.bin$/g, ""), modelPath: explicit };
  const home = os.homedir();
  const candidates = [
    path.join(home, ".goodjob-whisper", "models", "ggml-small.bin"),
    path.join(home, ".goodjob-whisper", "ggml-small.bin"),
    path.join(home, ".goodjob-whisper", "models", "ggml-base.bin"),
    path.join(home, ".goodjob-whisper", "ggml-base.bin")
  ];
  const modelPath = firstExisting(candidates);
  const name = modelPath ? path.basename(modelPath).replace(/^ggml-|\.bin$/g, "") : "small";
  return { name, modelPath: modelPath || candidates[0] };
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(400, () => done(false));
  });
}

/** PCM16LE 单声道 → WAV（44 字节头）。whisper-server 只吃音频文件，不吃裸 PCM。 */
export function pcm16ToWav(pcm: Buffer, sampleRate = 16_000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class CallTranscribeService {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lastError = "";
  /**
   * 端口上已经有一个**不是本进程拉起来的** whisper-server（典型场景：插件热重载，
   * 上一次的子进程还活着）。这种时候 `child` 为 null，但服务其实是可用的 ——
   * 直接按 child 判 `running` 会显示「没在跑」，用户会以为坏了。
   */
  private external = false;
  private readonly port = Number(process.env.WHISPER_SERVER_PORT ?? DEFAULT_PORT);

  /**
   * ⚠️ 每次都现查，不在构造时缓存。
   * 现实里"先装插件、后装 whisper"是常态（本机这次就是：插件一直在跑，二进制几分钟后才编译出来）。
   * 缓存路径会让 status 一直报"没找到"，而实际已经装好 —— 用户只会觉得这功能坏了。
   */
  private binaryPath(): string {
    return resolveBinary();
  }

  private modelInfo(): { name: string; modelPath: string } {
    return resolveModel();
  }

  status(): CallTranscribeStatus {
    const binary = this.binaryPath();
    const model = this.modelInfo();
    const binaryOk = Boolean(binary) && existsSync(binary);
    const modelOk = Boolean(model.modelPath) && existsSync(model.modelPath);
    const reason = !binaryOk
      ? "没找到 whisper-server：执行 brew install whisper-cpp"
      : !modelOk
        ? `没找到模型文件：${model.modelPath}`
        : this.lastError;
    return {
      available: binaryOk && modelOk,
      running: Boolean(this.child && this.child.exitCode === null) || this.external,
      model: model.name,
      modelPath: model.modelPath,
      reason
    };
  }

  private async start(): Promise<void> {
    if (this.child && this.child.exitCode === null) return;
    const status = this.status();
    if (!status.available) throw new Error(status.reason || "whisper 未安装");
    if (await isPortOpen(this.port)) {
      // 端口已被上一次进程占着（热重载常见）：记下来，status 才不会谎报"没在跑"
      this.external = true;
      return;
    }

    const args = [
      "-m", this.modelInfo().modelPath,
      "--host", "127.0.0.1",
      "--port", String(this.port),
      "-l", String(process.env.WHISPER_LANGUAGE ?? "auto"),
      "-t", String(Math.max(2, Math.floor((os.cpus()?.length ?? 4) / 2))),
      "-nt"
    ];
    const child = spawn(this.binaryPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    child.once("exit", (code) => {
      if (this.child === child) this.child = null;
      if (code !== 0 && code !== null) this.lastError = `whisper-server 退出（code ${code}）`;
    });
    child.once("error", (error) => {
      this.lastError = `whisper-server 启动失败：${error.message}`;
      if (this.child === child) this.child = null;
    });
    // stderr 不打印全文：模型加载会刷几百行，只需要留最后一行用于排错。
    child.stderr?.on("data", (chunk: Buffer) => {
      const line = String(chunk).trim().split("\n").pop() ?? "";
      if (line) this.lastError = line.slice(0, 300);
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await isPortOpen(this.port)) {
        this.lastError = "";
        return;
      }
      if (child.exitCode !== null) throw new Error(this.lastError || "whisper-server 没起来");
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error("whisper-server 启动超时（模型加载可能过慢）");
  }

  private async ensure(): Promise<void> {
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  /**
   * 先把 `whisper-server` 拉起来（不转写任何东西）。
   *
   * 为什么要单独一个入口：模型加载要 1~3 秒，而**通话第一句经常就是「喂，能听见吗」**。
   * 等第一段音频到了才开始加载，用户看到的是"接通后头一两句永远缺一句"。
   * 所以扩展一检测到通话就先打这里，把加载时间挪到双方还在寒暄的时候。
   */
  async warm(): Promise<void> {
    await this.ensure();
  }

  /** 打一次 `/inference`。`verbose` 时服务端会回 `language`，用于判断要不要补跑简体。 */
  private async request(
    wav: Buffer,
    options: { language: string; prompt?: string; verbose?: boolean }
  ): Promise<{ text: string; language: string }> {
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "chunk.wav");
    form.append("response_format", options.verbose ? "verbose_json" : "json");
    form.append("temperature", "0");
    form.append("language", options.language);
    if (options.prompt) form.append("prompt", options.prompt);
    const response = await fetch(`http://127.0.0.1:${this.port}/inference`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`whisper-server ${response.status}：${text.slice(0, 200)}`);
    try {
      const parsed = JSON.parse(text) as { text?: string; language?: string };
      return { text: String(parsed.text ?? "").trim(), language: String(parsed.language ?? "") };
    } catch {
      return { text: text.trim(), language: "" };
    }
  }

  /**
   * 转写一段音频。串行执行：whisper-server 本身是单进程解码，
   * 并发打进去只会在服务端排队，还会让两路（客户/我）互相插队。
   *
   * 请求次数（决定延迟）：
   *   · 已锁定语种 → **1 次**（prompt 随语种一起带上）；
   *   · `auto` → **2 次**：第一遍只用来判语种，判出中/英后再带 prompt 重跑。
   *     多花约 1 秒，但实测这一遍能把 CER 从 30% 压到 11% —— 对"听不懂的报价"
   *     来说，慢一点远好过错一个数字。
   */
  async transcribe(
    pcm: Buffer,
    options: { sampleRate?: number; language?: string; prompt?: string } = {}
  ): Promise<{ text: string; language: string }> {
    if (!pcm.length) return { text: "", language: "" };
    await this.ensure();
    const wav = pcm16ToWav(pcm, options.sampleRate ?? 16_000);
    const language = options.language || String(process.env.WHISPER_LANGUAGE ?? "auto");
    const auto = !language || language === "auto";

    const run = async (): Promise<{ text: string; language: string }> => {
      if (!auto) {
        // 调用方给了 prompt 就用它，否则按语种取默认热词（中文里已含繁简偏置）。
        const prompt = options.prompt ?? promptForLanguage(language);
        const first = await this.request(wav, { language, prompt, verbose: true });
        const used = first.language || language;
        if (!needsSimplifiedZh(first.text, used)) return { text: cleanTranscript(first.text), language: used };
        // 仍出繁体：用更短的纯普通话 prompt 再压一次（长 prompt 里的英文缩写有时会把模型带回繁体）。
        const second = await this.request(wav, { language: "zh", prompt: SIMPLIFIED_ZH_PROMPT });
        return { text: cleanTranscript(second.text || first.text), language: "zh" };
      }

      // ── auto：第一遍探语种，第二遍按探到的语种带热词重跑 ──
      const probe = await this.request(wav, { language: "auto", verbose: true });
      // 探到的语种先用字形复核一遍：短句被判错方向时，这一步能把中文从「按英文解码」里救回来。
      const detected = refineLanguage(String(probe.language || "").toLowerCase(), probe.text);
      const retryPrompt = options.prompt ?? promptForLanguage(detected);
      // 没有对应热词（西语/阿语等）：不重跑，把第一遍的结果和语种一起交回去，
      // 页面侧会把 "es" 记下来，后面这段对话就不用再靠 auto 猜了。
      if (!retryPrompt) return { text: cleanTranscript(probe.text), language: detected };
      // 语种被复核改过时，第一遍的文本是按错语种解出来的，必须重跑；
      // 没改的话第一遍已经是对的（只是没带热词），照样重跑一遍换准确率。
      const second = await this.request(wav, { language: detected, prompt: retryPrompt, verbose: true });
      // 第二遍如果因为 prompt 反而变空（极少见），退回第一遍的结果，别把句子吞掉。
      return { text: cleanTranscript(second.text || probe.text), language: detected };
    };
    const task = this.queue.then(run, run);
    this.queue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }
}

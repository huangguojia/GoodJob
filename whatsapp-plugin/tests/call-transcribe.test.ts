import { describe, expect, it } from "vitest";
import { cleanTranscript, needsSimplifiedZh, pcm16ToWav, promptForLanguage, refineLanguage } from "../src/server/services/call-transcribe-service";

/**
 * WAV 封装的回归测试。
 *
 * whisper-server 只吃"音频文件"，不吃裸 PCM；这一层写错（长度字段、声道数、采样率）
 * 的表现是「接口 200 但转出来是空白/杂音」，比直接报错难查得多。所以把头逐字段钉住。
 */
describe("pcm16ToWav", () => {
  const pcm = Buffer.from([0x01, 0x00, 0x02, 0x00, 0x03, 0x00]);

  it("写出合法的 RIFF/WAVE 头", () => {
    const wav = pcm16ToWav(pcm, 16_000);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.subarray(12, 16).toString("ascii")).toBe("fmt ");
    expect(wav.subarray(36, 40).toString("ascii")).toBe("data");
  });

  it("头里声明的是 16k 单声道 16bit", () => {
    const wav = pcm16ToWav(pcm, 16_000);
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(28)).toBe(32_000); // byte rate = rate * 2
    expect(wav.readUInt16LE(32)).toBe(2); // block align
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
  });

  it("长度字段与实际内容一致（少算 44 字节会让服务端截断音频）", () => {
    const wav = pcm16ToWav(pcm, 16_000);
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(44).equals(pcm)).toBe(true);
  });

  it("空音频也能封装（服务端据此返回空串，而不是崩）", () => {
    const wav = pcm16ToWav(Buffer.alloc(0), 16_000);
    expect(wav.length).toBe(44);
    expect(wav.readUInt32LE(40)).toBe(0);
  });
});

/**
 * 「要不要补跑一次简体化」的判据。
 *
 * 判据错了的两种坏法：
 *   - 太宽（字符集里混进简体同形字，如 迎/境/幕/池/示）→ 每句中文都多跑一次，
 *     台词延迟从 ~1 秒变 ~1.8 秒，而结果是同一句，用户只会觉得"这功能有点卡"；
 *   - 太窄（漏掉常用繁体字）→ 屏幕上出现"確認一下交期"，看着像翻译腔。
 * 所以两边都钉住：命中要补，不该补的一次都不许多。
 */
describe("needsSimplifiedZh", () => {
  it("中文结果里出现繁体字 → 补", () => {
    expect(needsSimplifiedZh("你好,我想確認一下交期大概是多久。", "chinese")).toBe(true);
    expect(needsSimplifiedZh("這個價格可以", "zh")).toBe(true);
    expect(needsSimplifiedZh("請問題", "zh-CN")).toBe(true);
  });

  it("已经是简体 → 不补（否则每句都多花 0.5~0.9 秒）", () => {
    expect(needsSimplifiedZh("你好,我想确认一下交期大概是多久。", "chinese")).toBe(false);
    expect(needsSimplifiedZh("这个价格可以，谢谢", "zh")).toBe(false);
  });

  it("简体同形字不许触发（欢迎/环境/屏幕/电池/显示 里没有繁体专用字）", () => {
    expect(needsSimplifiedZh("欢迎光临，环境不错，屏幕和电池都显示正常", "chinese")).toBe(false);
  });

  it("非中文语种一律不补（西语/英语不会被中文 prompt 带出幻觉）", () => {
    expect(needsSimplifiedZh("necesitamos 3000 unidades del modelo TR-700", "spanish")).toBe(false);
    expect(needsSimplifiedZh("Hello, what is your best price?", "english")).toBe(false);
    // 语种没识别出来时也不补：宁可留一次繁体，也不要给整段对话加一倍延迟
    expect(needsSimplifiedZh("你好,我想確認一下", "")).toBe(false);
  });

  it("中文语种 + 纯拉丁文本 → 不补（号码、型号这类短句不该被重跑）", () => {
    expect(needsSimplifiedZh("TR-700, 3000 pcs", "chinese")).toBe(false);
  });
});

/**
 * 清洗"没有内容的产物"。
 *
 * 这些字符串不是用户说的话，是 whisper 在静音/噪声/语种设错时的固定反应。
 * 把它们送进面板，用户看到的是「空白音频」「等等等等」这种鬼话，还会被当成
 * 正文去翻译 —— 所以判据要既**拦得住垃圾**，又**一个字都不改真话**。
 */
describe("cleanTranscript", () => {
  it("非语音标记整句丢掉", () => {
    expect(cleanTranscript("[BLANK_AUDIO]")).toBe("");
    expect(cleanTranscript("[MUSIC]")).toBe("");
    expect(cleanTranscript("[ Silence ]")).toBe("");
    expect(cleanTranscript("(speaking in foreign language)")).toBe("");
    expect(cleanTranscript("（背景音）")).toBe("");
  });

  it("同一词复读 6 次以上整句丢掉（whisper 的复读幻觉）", () => {
    expect(cleanTranscript("Wait wait wait wait wait wait")).toBe("");
    expect(cleanTranscript("Wait, wait, wait, wait, wait, wait.")).toBe("");
  });

  it("真话一个字都不改", () => {
    expect(cleanTranscript("Wait for my confirmation, please.")).toBe("Wait for my confirmation, please.");
    expect(cleanTranscript("No, no, no, that is not what I meant.")).toBe("No, no, no, that is not what I meant.");
    expect(cleanTranscript("好的，我明天把报价单发给你。")).toBe("好的，我明天把报价单发给你。");
    // 标记只在**整句就是标记**时才丢；夹在正文里的型号/规格要留着
    expect(cleanTranscript("We need 3000 pcs of TR-700 (black).")).toBe("We need 3000 pcs of TR-700 (black).");
  });

  it("空白输入返回空串（不是 undefined，调用方要能直接判空）", () => {
    expect(cleanTranscript("")).toBe("");
    expect(cleanTranscript("   \n ")).toBe("");
  });
});

/**
 * 业务热词（initial prompt）。
 *
 * 这一层是**准确率的最大杠杆**，实测：
 *   · 中文外贸句 CER 29.8% → 11.5%；「HS/MOQ/四十尺高柜」那句 10.8% → 0.0%
 *   · 英文句 WER 16.1% → 6.5%（MOQ 从 mock 变对）
 *
 * 但它同时是**最容易反噬**的一层：prompt 与音频语种不一致时，模型会把 prompt
 * 当成"上一句"接着写。实测西语音频配中文 prompt，开头凭空多出 "En la primera vez,"。
 * 所以下面既钉"该有的时候有"，也钉"不该有的时候一个字都不能有"。
 */
describe("promptForLanguage", () => {
  it("中文：带上繁简偏置和外贸热词", () => {
    const prompt = promptForLanguage("zh");
    expect(prompt).toContain("以下是普通话的句子");
    expect(prompt).toContain("FOB");
    expect(prompt).toContain("MOQ");
    expect(prompt).toContain("HS 编码");
    expect(prompt).toContain("二十尺柜");
    // 繁简偏置必须是**开头**那句：whisper.cpp 推荐的写法就是把它放在最前面
    expect(prompt.startsWith("以下是普通话的句子")).toBe(true);
  });

  it("用例句式而不是词表（词表式会把模型带回繁体，FOB 也修不对）", () => {
    const prompt = promptForLanguage("zh");
    // 必须是一条能读通的话：实测「罗列三十个术语」反而不如「我们报 FOB 深圳价」
    expect(prompt).toContain("我们报 FOB 深圳价");
    // 关键词要出现**两次**：只出现一遍时 FOB 仍会被听成 FOP / Fab
    expect(prompt.split("FOB").length - 1).toBeGreaterThanOrEqual(2);
    // 不许塞具体数字：prompt 里的金额会把输出拉成中文数字写法
    expect(/\d{3,}|一千二百|三十五天/.test(prompt)).toBe(false);
    // 词表式那种顿号长清单不再出现（出现就说明被改回去了）
    expect(prompt.length).toBeLessThan(160);
  });

  it("中文的语种别名都认（chinese / zh-CN / ZH）", () => {
    for (const value of ["chinese", "zh-CN", "ZH", "zh-TW"]) {
      expect(promptForLanguage(value)).toContain("以下是普通话的句子");
    }
  });

  it("英文：用英文热词，且**一个汉字都不能有**（否则会把中文带进英文解码）", () => {
    const prompt = promptForLanguage("en");
    expect(prompt).toContain("MOQ");
    expect(prompt).toContain("lead time");
    expect(/[\u4e00-\u9fff]/u.test(prompt)).toBe(false);
  });

  it("自动 / 其他语种：一律空串（不知道语种时带任何 prompt 都是赌）", () => {
    // 这条是踩过的坑：西语音频被 small 判成 english 时，如果这里还塞英文 prompt，
    // 错得更彻底；auto 必须先探语种，再决定带哪一份。
    for (const value of ["auto", "", "es", "spanish", "ar", "ru", "pt-BR"]) {
      expect(promptForLanguage(value)).toBe("");
    }
  });

  it("prompt 长度受控（超过 600 字会被接口拒掉，且长 prompt 容易把模型带回繁体）", () => {
    for (const value of ["zh", "en"]) {
      expect(promptForLanguage(value).length).toBeLessThan(600);
    }
  });
});

/**
 * 语种复核。
 *
 * 这段逻辑存在的唯一理由：通话里的短句（「喂，你好」0.6 秒）几乎没有声学特征，
 * whisper 会把中文判成英语。判成英语之后第二遍会带着英文 prompt 按英文解码，
 * 整句变成拼音——这是「采不准」里唯一**不可挽回**的一类错（重跑也救不回来）。
 * 所以用转写出来的字形再复核一次，把这类错挡在送 prompt 之前。
 */
describe("refineLanguage", () => {
  it("自称英语、正文却是汉字 → 纠成中文（这是最伤的一类错）", () => {
    expect(refineLanguage("en", "我们先确认一下交货期")).toBe("zh");
  });

  it("中文里夹英文术语，仍算中文（外贸场景每天都有）", () => {
    expect(refineLanguage("en", "我们报 FOB 深圳价，MOQ 是多少")).toBe("zh");
  });

  it("纯英文不动（一个汉字都不出现时天然不会被改）", () => {
    expect(refineLanguage("en", "What is your MOQ for the 40 foot container")).toBe("en");
  });

  it("单个汉字不足以翻案（避免英文句里夹一个「嗯」就被拉成中文）", () => {
    expect(refineLanguage("en", "Yes we can do that 嗯")).toBe("en");
  });

  it("反方向：自称中文却一个汉字都没有 → 判成英语", () => {
    expect(refineLanguage("zh", "Could you please confirm the lead time")).toBe("en");
  });

  it("日文不动：汉字在日文里同样密集，硬纠会把整段日语拉成中文", () => {
    expect(refineLanguage("ja", "見積書を送っていただけますか")).toBe("ja");
    expect(refineLanguage("ko", "견적서를 보내 주시겠어요")).toBe("ko");
  });

  it("被判成英语的日文也不许拉成中文（假名/谚文在场就说明不是中文）", () => {
    // 这条是上一版漏掉的：只测「detected 是 ja」永远走不到 isEnglish 分支，
    // 把假名保护整段删掉测试也不会红。真正的风险是 whisper 把短句日语判成 en。
    expect(refineLanguage("en", "見積書を送っていただけますか")).toBe("en");
    expect(refineLanguage("en", "견적서를 보내 주시겠어요")).toBe("en");
  });

  it("西语等不在中英范围内的语种原样返回（收窄的是菜单，不是识别能力）", () => {
    expect(refineLanguage("es", "¿Podrían confirmar el plazo de entrega?")).toBe("es");
  });

  it("空结果不猜（噪声段本来就该被 cleanTranscript 丢掉）", () => {
    expect(refineLanguage("en", "")).toBe("en");
    expect(refineLanguage("", "  ")).toBe("");
  });
});

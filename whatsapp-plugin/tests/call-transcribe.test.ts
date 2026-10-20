import { describe, expect, it } from "vitest";
import { cleanTranscript, needsSimplifiedZh, pcm16ToWav } from "../src/server/services/call-transcribe-service";

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

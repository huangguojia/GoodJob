import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WhatsAppNumberLink, whatsAppWebHref } from "../src/web/components/ui";

/**
 * 客户号码 → WhatsApp **网页版**直链。
 *
 * 这条链路有两个容易踩的坑，都在这里钉住：
 *
 * 1) 号码里混进 `+`、空格或横线就变成死链 —— 网页版只接受纯数字，
 *    而它对无效号码的处理是静默落到首页，用户以为「点了没反应」。
 *
 * 2) 一旦有人把它改回 `wa.me` / `api.whatsapp.com`，装了 WhatsApp 桌面客户端的
 *    机器会被唤起 App，落到另一个关联设备，而不是使用者已扫码登录的浏览器会话。
 *    这条断言是防回归的护栏，不是形式主义。
 */
describe("whatsAppWebHref", () => {
  it("剥离 +、空格与横线，只留网页版接受的纯数字", () => {
    expect(whatsAppWebHref("+86 190-7623-4587")).toBe("https://web.whatsapp.com/send?phone=8619076234587");
    expect(whatsAppWebHref("+39 333 124 5678")).toBe("https://web.whatsapp.com/send?phone=393331245678");
  });

  it("锁定网页版，不得回流到会被桌面客户端接管的 universal 链接", () => {
    const href = whatsAppWebHref("+393331245678");
    expect(href.startsWith("https://web.whatsapp.com/")).toBe(true);
    expect(href).not.toContain("wa.me");
    expect(href).not.toContain("api.whatsapp.com");
    expect(href).not.toContain("whatsapp://");
  });

  it("位数不足 6 位视为无效，返回空串而不是死链", () => {
    expect(whatsAppWebHref("")).toBe("");
    expect(whatsAppWebHref("12345")).toBe("");
    expect(whatsAppWebHref(null)).toBe("");
    expect(whatsAppWebHref(undefined)).toBe("");
  });
});

describe("WhatsAppNumberLink", () => {
  it("渲染成新标签外链，并保留调用方传入的 className", () => {
    const html = renderToStaticMarkup(createElement(WhatsAppNumberLink, { phone: "+393331245678", className: "mono" }));
    expect(html).toContain('href="https://web.whatsapp.com/send?phone=393331245678"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("mono");
  });

  it("号码无效时退化成纯文本，不产生可点的死链", () => {
    const html = renderToStaticMarkup(createElement(WhatsAppNumberLink, { phone: "123" }));
    expect(html).not.toContain("href");
    expect(html).toContain("123");
  });
});

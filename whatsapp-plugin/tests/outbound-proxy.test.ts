import { afterEach, describe, expect, it } from "vitest";
import { configureOutboundProxy, isProxiedHost, outboundProxyInit } from "../src/server/outbound-proxy";

describe("Meta outbound proxy routing", () => {
  afterEach(() => {
    configureOutboundProxy(undefined);
  });

  it("proxies only Meta hosts, never local or third-party addresses", () => {
    for (const url of [
      "https://graph.facebook.com/v21.0/123456/messages",
      "https://GRAPH.FACEBOOK.COM/v21.0/",
      "https://lookaside.fbsbx.com/whatsapp_business/attachments/",
      "https://scontent.xx.fbcdn.net/v/t1.0-9/photo.jpg",
      "https://mmg.whatsapp.net/mms/media"
    ]) {
      expect(isProxiedHost(url)).toBe(true);
    }
    for (const url of [
      "http://127.0.0.1:4188/api/health",
      "http://127.0.0.1:3999/v21.0/123456",
      "http://localhost:3100/api/health",
      "https://api.example.test/v1/chat/completions",
      "https://notfacebook.com/v21.0/",
      "not a url"
    ]) {
      expect(isProxiedHost(url)).toBe(false);
    }
  });

  it("is a no-op until a proxy URL is configured", () => {
    configureOutboundProxy(undefined);
    expect(outboundProxyInit("https://graph.facebook.com/v21.0/")).toEqual({});
    configureOutboundProxy("   ");
    expect(outboundProxyInit("https://graph.facebook.com/v21.0/")).toEqual({});
  });

  it("attaches the proxy dispatcher to Meta hosts and leaves others untouched", () => {
    configureOutboundProxy("http://127.0.0.1:29290");
    expect(outboundProxyInit("https://graph.facebook.com/v21.0/").dispatcher).toBeDefined();
    expect(outboundProxyInit("http://127.0.0.1:4188/api/health")).toEqual({});
    configureOutboundProxy(undefined);
    expect(outboundProxyInit("https://graph.facebook.com/v21.0/")).toEqual({});
  });
});

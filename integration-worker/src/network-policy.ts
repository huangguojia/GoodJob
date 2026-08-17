import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface EndpointPolicy {
  allowedHosts: readonly string[];
  allowedPorts: readonly number[];
  allowInsecureLoopback?: boolean;
  maxRedirects?: number;
}

function blockedIpv4(address: string) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((item) => !Number.isInteger(item))) return true;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224;
}

function blockedIpv6(address: string) {
  const normalized = address.toLowerCase();
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fe8")
    || normalized.startsWith("fe9")
    || normalized.startsWith("fea")
    || normalized.startsWith("feb")
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("ff");
}

function isLoopbackHost(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export async function validateMcpEndpoint(rawUrl: string | URL, policy: EndpointPolicy) {
  const url = rawUrl instanceof URL ? new URL(rawUrl) : new URL(rawUrl);
  if (url.username || url.password || url.hash) throw new Error("INTEGRATION_ENDPOINT_BLOCKED: endpoint 不能包含账号、密码或 fragment");
  const insecureLoopback = url.protocol === "http:"
    && Boolean(policy.allowInsecureLoopback)
    && isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !insecureLoopback) {
    throw new Error("INTEGRATION_ENDPOINT_BLOCKED: MCP endpoint 必须使用 HTTPS");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (!policy.allowedHosts.map((item) => item.toLowerCase()).includes(hostname)) {
    throw new Error("INTEGRATION_ENDPOINT_BLOCKED: endpoint 主机不在连接器白名单");
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!policy.allowedPorts.includes(port)) {
    throw new Error("INTEGRATION_ENDPOINT_BLOCKED: endpoint 端口未获批准");
  }
  if (insecureLoopback) return url;

  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("INTEGRATION_ENDPOINT_BLOCKED: endpoint DNS 无可用地址");
  for (const entry of addresses) {
    const family = isIP(entry.address);
    if ((family === 4 && blockedIpv4(entry.address)) || (family === 6 && blockedIpv6(entry.address))) {
      throw new Error("INTEGRATION_ENDPOINT_BLOCKED: endpoint 解析到私网或保留地址");
    }
  }
  return url;
}

export function createValidatedFetch(policy: EndpointPolicy): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    let request = new Request(input, init);
    const maxRedirects = Math.max(0, Math.min(5, policy.maxRedirects ?? 2));
    for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
      await validateMcpEndpoint(request.url, policy);
      const response = await fetch(request, { redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location || attempt === maxRedirects) throw new Error("INTEGRATION_ENDPOINT_BLOCKED: MCP 重定向不完整或次数超限");
      const nextUrl = new URL(location, request.url);
      await validateMcpEndpoint(nextUrl, policy);
      const preserveBody = response.status === 307 || response.status === 308;
      const headers = new Headers(request.headers);
      if (new URL(request.url).origin !== nextUrl.origin) {
        headers.delete("authorization");
        headers.delete("cookie");
      }
      request = new Request(nextUrl, {
        method: preserveBody ? request.method : "GET",
        headers,
        body: preserveBody ? await request.clone().arrayBuffer() : undefined,
        signal: request.signal
      });
    }
    throw new Error("INTEGRATION_ENDPOINT_BLOCKED: MCP 重定向次数超限");
  };
}

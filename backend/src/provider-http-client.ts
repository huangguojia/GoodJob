import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { ProviderHttpClient, ProviderNetworkPolicy } from "./provider-contract.js";
import { ProviderContractError } from "./provider-contract.js";
import {
  isForbiddenNetworkHostname,
  isPrivateNetworkAddress,
  normalizeNetworkHostname
} from "./provider-network-security.js";
import { recordProviderHttpResult } from "./provider-request-logging.js";

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FORBIDDEN_REQUEST_HEADERS = [
  "connection",
  "content-length",
  "host",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
];
const SENSITIVE_REQUEST_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-subscription-token"
];
const SAFE_CROSS_HOST_HEADERS = [
  "accept",
  "accept-language",
  "cache-control",
  "user-agent"
];

type ProviderHttpTestTransport = (url: string, init: RequestInit) => Promise<Response>;

let providerHttpTestTransport: ProviderHttpTestTransport | null = null;

function policyError(message: string) {
  return new ProviderContractError({
    code: "PROVIDER_POLICY_BLOCKED",
    retryable: false,
    retryAfterAt: null,
    publicMessage: message,
    httpStatus: null,
    phase: "contract"
  });
}

async function resolveAllowedAddress(hostname: string) {
  const normalizedHostname = normalizeNetworkHostname(hostname);
  const addresses = isIP(normalizedHostname)
    ? [{ address: normalizedHostname, family: isIP(normalizedHostname) }]
    : await lookup(normalizedHostname, { all: true, verbatim: true });
  const allowed = addresses.filter((item) => !isPrivateNetworkAddress(item.address));
  if (!allowed.length || allowed.length !== addresses.length) {
    throw policyError("数据源地址未通过公网安全检查");
  }
  return allowed[0];
}

function validateTarget(rawUrl: string, policy: ProviderNetworkPolicy, redirect = false) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw policyError("数据源地址格式无效");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw policyError("数据源只允许使用不含账号密码的 HTTPS 标准端口");
  }
  const hostname = normalizeNetworkHostname(url.hostname);
  if (isForbiddenNetworkHostname(hostname)) {
    throw policyError("数据源目标未通过公网安全检查");
  }
  const allowedHosts = redirect
    ? [...policy.allowedHosts, ...(policy.redirectHosts || [])]
    : policy.allowedHosts;
  if (!allowedHosts.map(normalizeNetworkHostname).includes(hostname)) {
    throw policyError("数据源目标不在已批准主机白名单");
  }
  if (!(policy.allowedPaths || []).includes(url.pathname)
    && !policy.allowedPathPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
    throw policyError("数据源目标路径不在已批准范围");
  }
  return url;
}

function redirectTarget(
  current: URL,
  location: string,
  policy: ProviderNetworkPolicy,
  hasSensitiveRequest: boolean
) {
  const next = validateTarget(new URL(location, current).toString(), policy, true);
  const currentHost = normalizeNetworkHostname(current.hostname);
  const nextHost = normalizeNetworkHostname(next.hostname);
  const redirectHosts = (policy.redirectHosts || []).map(normalizeNetworkHostname);
  if (nextHost !== currentHost && !redirectHosts.includes(nextHost)) {
    throw policyError("数据源跨主机重定向未获批准");
  }
  if (nextHost !== currentHost && hasSensitiveRequest) {
    throw policyError("携带凭据的数据源请求禁止跨主机重定向");
  }
  return next;
}

function requestBody(init: RequestInit) {
  if (init.body === undefined || init.body === null) return null;
  if (typeof init.body === "string") return Buffer.from(init.body);
  if (init.body instanceof Uint8Array) return Buffer.from(init.body);
  if (init.body instanceof URLSearchParams) return Buffer.from(init.body.toString());
  throw policyError("数据源请求体类型不受支持");
}

function errorCode(error: unknown) {
  const message = error instanceof Error ? error.message.toLocaleLowerCase() : "";
  return message.includes("timeout")
    ? "timeout"
    : message.includes("abort")
      ? "aborted"
      : message.includes("超过允许大小")
        ? "response_too_large"
        : error instanceof ProviderContractError
          ? "provider_policy_blocked"
          : "network_error";
}

function requestContainsCredentials(url: URL, init: RequestInit) {
  const headers = new Headers(init.headers);
  if (SENSITIVE_REQUEST_HEADERS.some((header) => headers.has(header))) return true;
  if ([...headers.keys()].some((header) => !SAFE_CROSS_HOST_HEADERS.includes(header.toLocaleLowerCase()))) return true;
  if (init.body !== undefined && init.body !== null) return true;
  return [...url.searchParams.keys()].some((key) =>
    /(api.?key|token|secret|password|signature|credential)/i.test(key)
  );
}

function responsePayload(status: number, body: Buffer): BodyInit | null {
  if ([101, 204, 205, 304].includes(status)) return null;
  const payload = new Uint8Array(body.length);
  payload.set(body);
  return payload;
}

function redirectInit(status: number, init: RequestInit): RequestInit {
  const method = String(init.method || "GET").toUpperCase();
  if (status !== 303 && !([301, 302].includes(status) && method === "POST")) return init;
  const headers = new Headers(init.headers);
  headers.delete("content-length");
  headers.delete("content-type");
  return {
    ...init,
    method: "GET",
    body: undefined,
    headers
  };
}

async function withinDeadline<T>(operation: Promise<T>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Provider request timeout")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function remainingDeadlineMs(deadlineAt: number) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error("Provider request timeout");
  return remaining;
}

async function requestOnce(
  url: URL,
  init: RequestInit,
  policy: ProviderNetworkPolicy,
  deadlineAt: number
): Promise<Response> {
  const maxBytes = policy.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES;
  const requestedAt = new Date().toISOString();
  const startedAt = Date.now();
  let logged = false;
  const recordResult = (result: {
    httpStatus: number;
    responseSize: number;
    errorCode: string;
  }) => {
    if (logged) return;
    logged = true;
    recordProviderHttpResult({
      ...result,
      durationMs: Date.now() - startedAt,
      requestedAt
    });
  };
  let method: string;
  let body: Buffer | null;
  let headers: Headers;
  let address: Awaited<ReturnType<typeof resolveAllowedAddress>> | undefined;
  try {
    method = String(init.method || "GET").toUpperCase();
    if (!policy.allowedMethods.includes(method as "GET" | "POST")) {
      throw policyError("数据源请求方法不在已批准范围");
    }
    body = requestBody(init);
    headers = new Headers(init.headers);
    if (FORBIDDEN_REQUEST_HEADERS.some((header) => headers.has(header))) {
      throw policyError("数据源请求包含不允许覆盖的网络头");
    }
    headers.set("accept-encoding", "identity");
    if (body) headers.set("content-length", String(body.length));
    if (!providerHttpTestTransport) {
      address = await withinDeadline(resolveAllowedAddress(url.hostname), remainingDeadlineMs(deadlineAt));
    }
  } catch (error) {
    recordResult({ httpStatus: 0, responseSize: 0, errorCode: errorCode(error) });
    throw error;
  }

  if (providerHttpTestTransport) {
    try {
      const response = await withinDeadline(providerHttpTestTransport(url.toString(), {
        ...init,
        method,
        headers,
        body: init.body
      }), remainingDeadlineMs(deadlineAt));
      const responseBody = Buffer.from(await withinDeadline(
        response.arrayBuffer(),
        remainingDeadlineMs(deadlineAt)
      ));
      if (responseBody.length > maxBytes) throw policyError("数据源响应超过允许大小");
      recordResult({
        httpStatus: response.status,
        responseSize: responseBody.length,
        errorCode: response.ok ? "" : `http_${response.status}`
      });
      const result = new Response(responsePayload(response.status, responseBody), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
      Object.defineProperty(result, "url", { value: url.toString() });
      return result;
    } catch (error) {
      recordResult({ httpStatus: 0, responseSize: 0, errorCode: errorCode(error) });
      throw error;
    }
  }

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const clearDeadline = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      recordResult({
        httpStatus: 0,
        responseSize: 0,
        errorCode: errorCode(error)
      });
      reject(error);
    };
    const requestHostname = normalizeNetworkHostname(url.hostname);
    const request = httpsRequest({
      protocol: "https:",
      hostname: requestHostname,
      port: 443,
      method,
      path: `${url.pathname}${url.search}`,
      servername: isIP(requestHostname) ? undefined : requestHostname,
      headers: Object.fromEntries(headers.entries()),
      lookup(_hostname, options, callback) {
        const resolved = address!;
        if (typeof options === "object" && options.all) {
          (callback as unknown as (
            error: NodeJS.ErrnoException | null,
            addresses: Array<{ address: string; family: number }>
          ) => void)(null, [resolved]);
          return;
        }
        (callback as unknown as (
          error: NodeJS.ErrnoException | null,
          address: string,
          family: number
        ) => void)(null, resolved.address, resolved.family);
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          const error = policyError("数据源响应超过允许大小");
          if (!settled) {
            settled = true;
            clearDeadline();
            recordResult({
              httpStatus: response.statusCode || 0,
              responseSize: size,
              errorCode: "response_too_large"
            });
            reject(error);
          }
          response.destroy(error);
          request.destroy(error);
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        clearDeadline();
        recordResult({
          httpStatus: response.statusCode || 502,
          responseSize: size,
          errorCode: response.statusCode && response.statusCode >= 200 && response.statusCode < 400
            ? ""
            : `http_${response.statusCode || 502}`
        });
        const responseHeaders: Array<[string, string]> = Object.entries(response.headers).flatMap(
          ([key, value]): Array<[string, string]> => {
            if (Array.isArray(value)) return value.map((item) => [key, item]);
            return value === undefined ? [] : [[key, String(value)]];
          }
        );
        const status = response.statusCode || 502;
        const result = new Response(responsePayload(status, Buffer.concat(chunks)), {
          status,
          headers: responseHeaders
        });
        Object.defineProperty(result, "url", { value: url.toString() });
        resolve(result);
      });
      response.on("error", finishReject);
    });
    const remainingMs = Math.max(1, deadlineAt - Date.now());
    deadlineTimer = setTimeout(
      () => request.destroy(new Error("Provider request timeout")),
      remainingMs
    );
    request.setTimeout(remainingMs, () => request.destroy(new Error("Provider request timeout")));
    request.on("error", finishReject);
    if (init.signal) {
      if (init.signal.aborted) {
        request.destroy(new Error("Provider request aborted"));
      } else {
        init.signal.addEventListener("abort", () => request.destroy(new Error("Provider request aborted")), { once: true });
      }
    }
    if (body) request.write(body);
    request.end();
  });
}

export function createProviderHttpClient(policy: ProviderNetworkPolicy): ProviderHttpClient {
  return {
    async fetch(rawUrl, init = {}) {
      const deadlineAt = Date.now() + (policy.timeoutMs || DEFAULT_TIMEOUT_MS);
      let current = validateTarget(rawUrl, policy);
      let currentInit = init;
      for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
        const response = await requestOnce(current, currentInit, policy, deadlineAt);
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get("location");
        if (!location) return response;
        if (redirectCount === MAX_REDIRECTS) throw policyError("数据源重定向次数过多");
        const next = redirectTarget(
          current,
          location,
          policy,
          requestContainsCredentials(current, currentInit)
        );
        currentInit = redirectInit(response.status, currentInit);
        current = next;
      }
      throw policyError("数据源重定向失败");
    }
  };
}

export function setProviderHttpTestTransport(transport: ProviderHttpTestTransport | null) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Provider HTTP test transport is only available in the test environment");
  }
  providerHttpTestTransport = transport;
}

export function assertProviderBaseUrlAllowed(rawUrl: string, policy: ProviderNetworkPolicy) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw policyError("数据源地址格式无效");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw policyError("数据源只允许使用不含账号密码的 HTTPS 标准端口");
  }
  const hostname = normalizeNetworkHostname(url.hostname);
  if (isForbiddenNetworkHostname(hostname)) {
    throw policyError("数据源目标未通过公网安全检查");
  }
  if (!policy.allowedHosts.map(normalizeNetworkHostname).includes(hostname)) {
    throw policyError("数据源目标不在已批准主机白名单");
  }
  const basePath = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  const approvedPaths = [...policy.allowedPathPrefixes, ...(policy.allowedPaths || [])];
  const pathAllowed = approvedPaths.some((prefix) =>
    url.pathname === prefix
    || url.pathname.startsWith(prefix)
    || prefix.startsWith(basePath)
    || (url.pathname === "/" && prefix.startsWith("/"))
  );
  if (!pathAllowed || url.search || url.hash) {
    throw policyError("数据源基础地址不在已批准路径范围");
  }
}

export function assertProviderRequestAllowed(
  rawUrl: string,
  method: string,
  policy: ProviderNetworkPolicy
) {
  validateTarget(rawUrl, policy);
  if (!policy.allowedMethods.includes(method.toUpperCase() as "GET" | "POST")) {
    throw policyError("数据源请求方法不在已批准范围");
  }
}

export function assertProviderRedirectAllowed(
  currentUrl: string,
  nextUrl: string,
  policy: ProviderNetworkPolicy,
  hasSensitiveRequest = false
) {
  redirectTarget(validateTarget(currentUrl, policy), nextUrl, policy, hasSensitiveRequest);
}

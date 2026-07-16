import type { ProviderNetworkPolicy } from "./provider-contract.js";
import {
  assertProviderBaseUrlAllowed,
  createProviderHttpClient
} from "./provider-http-client.js";

const AI_HTTP_TIMEOUT_MS = 120_000;
const AI_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function aiNetworkPolicy(rawBaseUrl: string): ProviderNetworkPolicy {
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error("AI Base URL 格式不正确");
  }
  const basePath = baseUrl.pathname || "/";
  return {
    allowedHosts: [baseUrl.hostname.toLocaleLowerCase()],
    allowedPathPrefixes: [basePath],
    allowedMethods: ["POST"],
    timeoutMs: AI_HTTP_TIMEOUT_MS,
    maxResponseBytes: AI_MAX_RESPONSE_BYTES
  };
}

export function assertAiBaseUrlAllowed(rawBaseUrl: string) {
  const normalized = rawBaseUrl.replace(/\/+$/, "");
  assertProviderBaseUrlAllowed(normalized, aiNetworkPolicy(normalized));
  return normalized;
}

export function createAiHttpClient(rawBaseUrl: string) {
  const normalized = assertAiBaseUrlAllowed(rawBaseUrl);
  return createProviderHttpClient(aiNetworkPolicy(normalized));
}

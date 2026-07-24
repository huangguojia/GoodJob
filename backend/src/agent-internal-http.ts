import { request as httpRequest } from "node:http";

export const AGENT_INTERNAL_API_MAX_RESPONSE_BYTES = 2_000_000;

export interface AgentInternalApiRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface AgentInternalApiResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export function requestAgentInternalApi(input: AgentInternalApiRequest) {
  return new Promise<AgentInternalApiResponse>((resolve, reject) => {
    const request = httpRequest(input.url, {
      method: input.method,
      headers: input.headers
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > AGENT_INTERNAL_API_MAX_RESPONSE_BYTES) {
          response.destroy(new Error("接口响应超过 Agent 单次读取上限"));
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => resolve({
        status: response.statusCode || 500,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
      response.on("aborted", () => reject(new Error("CRM 内部接口响应中断")));
      response.on("error", reject);
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("CRM 内部接口请求超时")));
    request.on("error", reject);
    if (input.body !== undefined) request.write(input.body);
    request.end();
  });
}

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { requestAgentInternalApi } from "./agent-internal-http.js";

const restrictedPorts = [6000, 6667, 10080, 4190];

async function startProbeServer() {
  for (const port of restrictedPorts) {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, method: request.method, body: Buffer.concat(chunks).toString("utf8") }));
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
      });
      return { server, port };
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE")) throw error;
    }
  }
  throw new Error("没有可用的 Fetch 受限端口执行 Agent 内部 HTTP 回归测试");
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const { server, port } = await startProbeServer();
try {
  const url = new URL(`http://127.0.0.1:${port}/agent-probe`);
  await assert.rejects(fetch(url), (error: unknown) => {
    const cause = error && typeof error === "object" && "cause" in error
      ? (error as { cause?: { message?: unknown } }).cause
      : undefined;
    return String(cause?.message || "").includes("bad port");
  });
  const response = await requestAgentInternalApi({
    url,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ company: "Agent transport probe" }),
    timeoutMs: 3_000
  });
  assert.equal(response.status, 201);
  assert.equal(String(response.headers["content-type"]), "application/json");
  assert.deepEqual(JSON.parse(response.body.toString("utf8")), {
    ok: true,
    method: "POST",
    body: JSON.stringify({ company: "Agent transport probe" })
  });
  console.log(JSON.stringify({ ok: true, restrictedPort: port, nodeHttpTransport: true }, null, 2));
} finally {
  await closeServer(server);
}

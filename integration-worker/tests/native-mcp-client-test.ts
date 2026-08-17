import assert from "node:assert/strict";
import { NativeMcpClient } from "../src/mcp/native-mcp-client.js";
import { startFakeMcpServer } from "./fake-mcp-server.js";

const fake = await startFakeMcpServer();
const endpoint = new URL(fake.endpoint);
const client = new NativeMcpClient({
  endpoint: fake.endpoint,
  endpointPolicy: {
    allowedHosts: ["127.0.0.1"],
    allowedPorts: [Number(endpoint.port)],
    allowInsecureLoopback: true,
    maxRedirects: 0
  },
  timeoutMs: 5_000,
  maxResponseBytes: 64 * 1024
});

try {
  const discovery = await client.discoverTools();
  assert.equal(discovery.serverName, "goodjob-fake-mcp");
  assert.ok(discovery.protocolVersion);
  assert.deepEqual(discovery.tools.map((tool) => tool.remoteName).sort(), ["company.lookup", "schema.version"]);
  const lookup = discovery.tools.find((tool) => tool.remoteName === "company.lookup");
  assert.ok(lookup?.schemaHash);
  assert.equal(lookup?.inputSchema.additionalProperties, false);

  const result = await client.callTool("company.lookup", { query: "Example Lighting", country: "US" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    company: "Example Lighting",
    country: "US",
    source: "fake-mcp://company.lookup",
    observedAt: "2026-08-07T00:00:00.000Z"
  });
  assert.rejects(() => client.callTool("unknown.tool", {}), /必须完成工具发现/u);
} finally {
  await client.close();
  await fake.close();
}

console.log(JSON.stringify({
  ok: true,
  sdk: "@modelcontextprotocol/client@2.0.0",
  streamableHttp: true,
  toolsList: true,
  toolCall: true,
  schemaNormalized: true,
  unknownToolBlocked: true
}, null, 2));

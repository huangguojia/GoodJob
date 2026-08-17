import assert from "node:assert/strict";
import { NativeMcpClient } from "../src/mcp/native-mcp-client.js";
import { sanitizeToolResult } from "../src/result-sanitizer.js";
import { startFakeMcpServer } from "./fake-mcp-server.js";

const fake = await startFakeMcpServer({ includeFailureTools: true });
const options = (endpointValue: string, timeoutMs: number, maxResponseBytes: number) => {
  const endpoint = new URL(endpointValue);
  return {
  endpoint: endpointValue,
  endpointPolicy: {
    allowedHosts: ["127.0.0.1"],
    allowedPorts: [Number(endpoint.port)],
    allowInsecureLoopback: true,
    maxRedirects: 0
  },
  timeoutMs,
  maxResponseBytes
  };
};
const normalClient = new NativeMcpClient(options(fake.endpoint, 2_000, 128 * 1024));

try {
  const firstDiscovery = await normalClient.discoverTools();
  const firstSchema = firstDiscovery.tools.find((tool) => tool.remoteName === "schema.version")?.schemaHash;
  fake.setSchemaVersion(2);
  const secondDiscovery = await normalClient.discoverTools();
  const secondSchema = secondDiscovery.tools.find((tool) => tool.remoteName === "schema.version")?.schemaHash;
  assert.ok(firstSchema && secondSchema && firstSchema !== secondSchema);

  const rateLimitResult = await normalClient.callTool("failure.rate_limit", {});
  assert.equal(rateLimitResult.isError, true);
  assert.equal((rateLimitResult._meta as Record<string, unknown>).httpStatus, 429);
  assert.equal((rateLimitResult._meta as Record<string, unknown>).retryAfterSeconds, 3);

  const untrusted = sanitizeToolResult(await normalClient.callTool("failure.untrusted", {}));
  assert.equal(untrusted.injectionDetected, true);
  assert.match(JSON.stringify(untrusted.value), /\[removed-script\]/u);
  assert.doesNotMatch(JSON.stringify(untrusted.value), /window\.bad/u);

  await assert.rejects(
    async () => sanitizeToolResult(await normalClient.callTool("failure.ambiguous_write", {}), {
      riskLevel: 4,
      completionEvidence: ["external_receipt_id"]
    }),
    /INTEGRATION_COMPLETION_EVIDENCE_MISSING/u
  );

  const oversizedFake = await startFakeMcpServer({ includeFailureTools: true });
  const oversizedClient = new NativeMcpClient(options(oversizedFake.endpoint, 2_000, 1_024));
  try {
    await oversizedClient.discoverTools();
    await assert.rejects(() => oversizedClient.callTool("failure.oversized", {}), /INTEGRATION_RESULT_TOO_LARGE/u);
  } finally {
    await oversizedClient.close();
    await oversizedFake.close();
  }

  const timeoutFake = await startFakeMcpServer({ includeFailureTools: true });
  const timeoutClient = new NativeMcpClient(options(timeoutFake.endpoint, 40, 128 * 1024));
  try {
    await timeoutClient.discoverTools();
    await assert.rejects(() => timeoutClient.callTool("failure.slow", { delayMs: 180 }), /timed out|timeout|abort/iu);
  } finally {
    await timeoutClient.close();
    await timeoutFake.close();
  }

  fake.rateLimitNextRequest(4);
  const rateLimitedHttp = await fetch(fake.endpoint, { method: "POST" });
  assert.equal(rateLimitedHttp.status, 429);
  assert.equal(rateLimitedHttp.headers.get("retry-after"), "4");

  fake.interruptNextRequest();
  await assert.rejects(() => fetch(fake.endpoint, { method: "POST" }), /fetch failed|socket|network/iu);

  console.log(JSON.stringify({
    ok: true,
    schemaChangeDetected: true,
    rateLimitMetadataPreserved: true,
    http429RetryAfterVerified: true,
    timeoutRejected: true,
    connectionInterruptionRejected: true,
    oversizedResponseRejected: true,
    writeEvidenceRequired: true,
    untrustedOutputSanitizedAndFlagged: true
  }, null, 2));
} finally {
  await normalClient.close();
  await fake.close();
}

import assert from "node:assert/strict";
import { runConnectorDriverComplianceSuite, type ConnectorManifest } from "@goodjob/integration-connector-sdk";
import { NativeMcpConnectorDriver } from "../src/drivers/native-mcp-connector-driver.js";
import { McpSessionManager } from "../src/mcp/mcp-session-manager.js";
import type { DriverRuntimeContext } from "../src/drivers/connector-driver.js";
import { startFakeMcpServer } from "./fake-mcp-server.js";

const fake = await startFakeMcpServer();
const endpoint = new URL(fake.endpoint);
const validManifest: ConnectorManifest = {
  schemaVersion: "1.0",
  stage: "available",
  driver: "native_mcp",
  endpoint: fake.endpoint,
  approvedHosts: ["127.0.0.1"],
  allowedPorts: [Number(endpoint.port)],
  allowInsecureLoopback: true,
  authentication: "none",
  maxTools: 20
};
const invalidManifest = {
  ...validManifest,
  endpoint: "https://unapproved.example.test/mcp"
};
const sessions = new McpSessionManager();
const driver = new NativeMcpConnectorDriver(sessions);
const context: DriverRuntimeContext = {
  connectionId: "compliance_native_mcp",
  manifest: validManifest as DriverRuntimeContext["manifest"],
  timeoutMs: 5_000,
  maxResponseBytes: 64 * 1024,
  requestId: "compliance-request"
};

try {
  const report = await runConnectorDriverComplianceSuite({
    driver,
    validManifest,
    invalidManifest,
    context,
    knownToolName: "company.lookup",
    knownToolInput: { query: "Example Lighting", country: "US" },
    maxTools: 20,
    getToolNames: (discovery) => discovery.tools.map((tool) => tool.remoteName),
    validateKnownResult(result) {
      assert.equal(result.isError, undefined);
      assert.equal((result.structuredContent as Record<string, unknown>).company, "Example Lighting");
    },
    isUnknownToolDenied: (error) => /INTEGRATION_TOOL_NOT_APPROVED/u.test(error instanceof Error ? error.message : String(error))
  });
  assert.equal(report.connectionClosed, true);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await sessions.close();
  await fake.close();
}

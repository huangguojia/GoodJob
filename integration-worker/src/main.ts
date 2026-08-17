import { createServer } from "node:http";
import {
  connectIntegrationWorkerDependencies,
  closeIntegrationWorkerDependencies
} from "./runtime.js";
import { loadIntegrationWorkerConfig } from "./runtime-config.js";
import { IntegrationWorkerRepository } from "./repository.js";
import { McpSessionManager } from "./mcp/mcp-session-manager.js";
import { IntegrationExecutionService } from "./integration-execution.js";
import { closeIntegrationQueueWorkers, startIntegrationQueueWorkers } from "./queue.js";
import { ConnectorDriverRegistry } from "./drivers/connector-driver-registry.js";
import { NativeMcpConnectorDriver } from "./drivers/native-mcp-connector-driver.js";
import { MicrosoftGraphConnectorDriver } from "./drivers/microsoft-graph-connector-driver.js";
import { GoogleWorkspaceConnectorDriver } from "./drivers/google-workspace-connector-driver.js";
import { GoogleDriveConnectorDriver } from "./drivers/google-drive-connector-driver.js";
import { ErpNextConnectorDriver } from "./drivers/erpnext-connector-driver.js";
import { EasyPostConnectorDriver } from "./drivers/easypost-connector-driver.js";
import { WeComConnectorDriver } from "./drivers/wecom-connector-driver.js";

const config = loadIntegrationWorkerConfig();
if (!config.enabled) {
  console.log("GoodJob Integration Worker disabled by INTEGRATION_ENABLED=false");
  process.exit(0);
}

const dependencies = await connectIntegrationWorkerDependencies(config);
const repository = IntegrationWorkerRepository.create(config.databaseUrl);
const sessions = new McpSessionManager();
const drivers = new ConnectorDriverRegistry([
  new NativeMcpConnectorDriver(sessions),
  new MicrosoftGraphConnectorDriver(),
  new GoogleWorkspaceConnectorDriver(),
  new GoogleDriveConnectorDriver(),
  new ErpNextConnectorDriver(),
  new EasyPostConnectorDriver(),
  new WeComConnectorDriver()
]);
const execution = new IntegrationExecutionService(
  repository,
  drivers,
  config.credentialKey,
  config.httpTimeoutMs,
  config.maxResponseBytes,
  config.artifactRetentionDays,
  config.webhookBaseUrl
);
const workers = await startIntegrationQueueWorkers(config, execution);
const server = createServer((request, response) => {
  if (request.url === "/healthz" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, worker: "integration", queue: "ready" }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "接口不存在" } }));
});

server.listen(config.port, config.host, () => {
  console.log(`GoodJob Integration Worker listening on http://${config.host}:${config.port}`);
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeIntegrationQueueWorkers(workers);
  await sessions.close();
  await repository.close();
  await closeIntegrationWorkerDependencies(dependencies);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}

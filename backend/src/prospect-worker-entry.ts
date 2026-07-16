import {
  validateAuthSecurity
} from "./auth.js";
import {
  validateAgentJobSecurity
} from "./agent-job-security.js";
import {
  validateProviderCredentialSecurity
} from "./credential-security.js";
import {
  validateMarketOpportunityCursorSecurity
} from "./market-opportunity-list.js";
import { createMysqlStore } from "./mysql-store.js";
import {
  ProspectWorkerService
} from "./prospect-worker-service.js";
import {
  validateProspectRunSecurity
} from "./prospect-runs.js";
import { loadLocalEnv } from "./runtime-env.js";
import {
  validateTradeObservationCursorSecurity
} from "./trade-observation-list.js";

loadLocalEnv();

async function startProspectWorker() {
  validateAuthSecurity();
  validateProviderCredentialSecurity();
  validateAgentJobSecurity();
  validateTradeObservationCursorSecurity();
  validateMarketOpportunityCursorSecurity();
  validateProspectRunSecurity();
  const store = await createMysqlStore({ processRole: "worker" });
  const service = new ProspectWorkerService({ store });
  await service.start();
  console.log("GoodJob CRM independent prospect worker started");

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(
      `GoodJob CRM prospect worker received ${signal}, shutting down`
    );
    try {
      await service.stop();
      await store.close?.();
      process.exit(0);
    } catch (error) {
      console.error(
        "GoodJob CRM prospect worker shutdown failed: "
        + (error instanceof Error ? error.message : String(error))
      );
      process.exit(1);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

if (process.env.NODE_ENV !== "test") {
  void startProspectWorker().catch((error) => {
    console.error(
      "GoodJob CRM prospect worker startup failed: "
      + (error instanceof Error ? error.message : String(error))
    );
    process.exit(1);
  });
}

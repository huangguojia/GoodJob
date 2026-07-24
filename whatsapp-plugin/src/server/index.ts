import pino from "pino";
import { createAppRuntime } from "./app.js";
import { loadConfig } from "./config.js";

const logger = pino({ name: "whatsapp-crm-plugin" });
const SHUTDOWN_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = await createAppRuntime(config);
  const host = config.host ?? "127.0.0.1";
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      logger.info({ signal }, "shutdown started");
      const timeout = setTimeout(() => {
        logger.fatal({ signal, timeoutMs: SHUTDOWN_TIMEOUT_MS }, "shutdown timed out");
        runtime.server.closeAllConnections();
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);

      try {
        await runtime.close();
        process.exitCode = 0;
        logger.info({ signal }, "shutdown completed");
      } catch (error) {
        process.exitCode = 1;
        logger.error(
          { signal, errorType: error instanceof Error ? error.name : typeof error },
          "shutdown failed"
        );
      } finally {
        clearTimeout(timeout);
      }
    })();
    return shutdownPromise;
  };

  const onSigint = (): void => void shutdown("SIGINT");
  const onSigterm = (): void => void shutdown("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      runtime.server.once("error", onError);
      runtime.server.listen(config.port, host, () => {
        runtime.server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await runtime.close().catch(() => undefined);
    throw error;
  }

  logger.info({ host, port: config.port }, "API listening");
}

void main().catch((error) => {
  process.exitCode = 1;
  logger.fatal(
    { errorType: error instanceof Error ? error.name : typeof error },
    "service startup failed"
  );
});

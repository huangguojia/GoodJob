import { execFile } from "node:child_process";
import { hostname, platform, release } from "node:os";
import { promisify } from "node:util";
import { executeCodexTask, resolveCodexBinary } from "./codex-adapter.js";
import { isBrowserCdpReady, isBrowserServiceReachable, startBrowserService } from "./browser-service.js";
import { GoodJobRunnerClient } from "./client.js";
import type { RunnerConfig, RunnerIdentity, TaskEventInput } from "./types.js";

const execFileAsync = promisify(execFile);
export const RUNNER_VERSION = "0.1.0";

export async function detectCodexVersion(binary = resolveCodexBinary()) {
  try {
    const { stdout, stderr } = await execFileAsync(binary, ["--version"], { timeout: 8_000 });
    return `${stdout}${stderr}`.trim().slice(0, 80);
  } catch {
    return "";
  }
}

export async function runnerIdentity(workspaces: string[]): Promise<RunnerIdentity> {
  const codexVersion = await detectCodexVersion();
  return {
    hostname: hostname(),
    platform: `${platform()} ${release()}`,
    runnerVersion: RUNNER_VERSION,
    codexVersion,
    capabilities: codexVersion ? ["codex", "browser"] : [],
    workspaces
  };
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function eventPublisher(client: GoodJobRunnerClient, taskId: string, leaseToken: string) {
  let pending: TaskEventInput[] = [];
  let timer: NodeJS.Timeout | null = null;
  let queue = Promise.resolve();
  const transmit = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending.length) return queue;
    const batch = pending.splice(0, 50);
    queue = queue.then(() => client.events(taskId, leaseToken, batch)).then(() => undefined).catch(() => undefined);
    if (pending.length) queue = queue.then(() => transmit());
    return queue;
  };
  return {
    async push(event: TaskEventInput) {
      pending.push(event);
      if (pending.length >= 10) void transmit();
      else if (!timer) {
        timer = setTimeout(() => { void transmit(); }, 180);
        timer.unref();
      }
    },
    async flush() {
      await transmit();
      await queue;
    }
  };
}

export async function runOneClaim(config: RunnerConfig, outerSignal?: AbortSignal, browserMcpUrl = "") {
  const client = new GoodJobRunnerClient({ serverUrl: config.serverUrl, token: config.token });
  const claim = await client.claim();
  if (!claim) return false;

  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  outerSignal?.addEventListener("abort", forwardAbort, { once: true });
  const identity = await runnerIdentity(config.workspaces);
  const heartbeat = setInterval(() => {
    void client.heartbeat({ ...identity, taskId: claim.task.id, leaseToken: claim.leaseToken })
      .then((state) => { if (!state.ok || state.cancelRequested) controller.abort(); })
      .catch(() => undefined);
  }, 8_000);
  heartbeat.unref();
  const publisher = eventPublisher(client, claim.task.id, claim.leaseToken);
  try {
    await client.event(claim.task.id, claim.leaseToken, { eventType: "status", message: "正在启动 Codex CLI" });
    const result = await executeCodexTask(claim.task, {
      allowedWorkspaces: config.workspaces,
      browserMcpUrl,
      signal: controller.signal,
      onEvent: (event) => publisher.push(event)
    });
    await publisher.flush();
    await client.complete(claim.task.id, claim.leaseToken, result);
  } catch (error) {
    await publisher.flush();
    await client.complete(claim.task.id, claim.leaseToken, {
      status: controller.signal.aborted ? "cancelled" : "failed",
      resultText: "",
      errorMessage: error instanceof Error ? error.message : "Runner 执行失败",
      outputTruncated: false,
      codexThreadId: ""
    }).catch(() => undefined);
  } finally {
    clearInterval(heartbeat);
    outerSignal?.removeEventListener("abort", forwardAbort);
  }
  return true;
}

export async function startRunner(config: RunnerConfig, signal: AbortSignal) {
  const client = new GoodJobRunnerClient({ serverUrl: config.serverUrl, token: config.token });
  const browserService = await startBrowserService();
  console.log(`[GoodJob Runner] 独立浏览器已就绪：${browserService.configuration.url}`);
  let lastHeartbeat = 0;
  let lastBrowserHealth = 0;
  let failures = 0;
  try {
    while (!signal.aborted) {
      if (Date.now() - lastBrowserHealth > 10_000) {
        const [mcpReady, chromeReady] = await Promise.all([
          isBrowserServiceReachable(browserService.configuration),
          isBrowserCdpReady(browserService.configuration)
        ]);
        if (!mcpReady || !chromeReady) throw new Error("独立浏览器服务已停止，Runner 将自动重启");
        lastBrowserHealth = Date.now();
      }
      try {
        if (Date.now() - lastHeartbeat > 10_000) {
          await client.heartbeat({ ...(await runnerIdentity(config.workspaces)), lastError: "" });
          lastHeartbeat = Date.now();
        }
        const handled = await runOneClaim(config, signal, browserService.configuration.url);
        failures = 0;
        if (!handled) await sleep(2_000);
      } catch (error) {
        failures += 1;
        const message = error instanceof Error ? error.message : "Runner 请求失败";
        if (failures === 1 || failures % 10 === 0) console.error(`[GoodJob Runner] ${message}`);
        await sleep(Math.min(15_000, 1_000 * failures));
      }
    }
  } finally {
    await browserService.stop();
  }
}

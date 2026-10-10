import { execFile } from "node:child_process";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { hostname, platform, release } from "node:os";
import { promisify } from "node:util";
import { executeCodexTask, resolveCodexBinary } from "./codex-adapter.js";
import { executeWorkbuddyTask, resolveWorkbuddyBinary, workbuddyProcessEnvironment } from "./workbuddy-adapter.js";
import { isBrowserCdpReady, isBrowserServiceReachable, tryStartBrowserService } from "./browser-service.js";
import { GoodJobRunnerClient } from "./client.js";
import type { RunnerConfig, RunnerIdentity, TaskEventInput } from "./types.js";

const execFileAsync = promisify(execFile);
export const RUNNER_VERSION = "0.1.0";

type CliKind = "codex" | "workbuddy";

/**
 * 探测失败原因。区分"本机没装"与"装了但起不来"很重要：
 * 前者是用户的选择（安静），后者是故障（必须让用户看见，例如账号切换后 CLI 起不来、
 * 或 homebrew 升级把 /opt/homebrew/bin/codebuddy 变成悬空符号链接）。
 */
function describeProbeFailure(binary: string, error: unknown) {
  if (!binary.includes("/")) {
    return { missing: true, reason: `未找到可执行文件 ${binary}（不在 PATH 中）` };
  }
  if (!existsSync(binary)) {
    // 路径不存在有两种：压根没有（用户的选择，安静），或符号链接悬空（故障，必须报）。
    // 本机历史坑：/opt/homebrew/bin/codebuddy → ~/.workbuddy/binaries/node/versions/<ver>/...
    // 宿主升级 Node 会清掉旧版本目录，链接就成了悬空，CLI 一夜之间全任务 Authentication required。
    const link = lstatSync(binary, { throwIfNoEntry: false });
    if (link?.isSymbolicLink()) {
      return { missing: false, reason: `符号链接已悬空：${binary} → ${readlinkSync(binary)}（目标已不存在，常见于宿主升级 Node 清掉旧版本目录）` };
    }
    return { missing: true, reason: `未找到可执行文件 ${binary}` };
  }
  const failure = error as { killed?: boolean; signal?: string | null; stderr?: unknown; code?: unknown };
  if (failure?.killed || failure?.signal === "SIGTERM") {
    return { missing: false, reason: `${binary} 启动超时（探测未在时限内退出）` };
  }
  const stderr = String(failure?.stderr ?? "").replace(/\s+/gu, " ").trim().slice(0, 160);
  return {
    missing: false,
    reason: stderr ? `${binary} 启动失败：${stderr}` : `${binary} 启动失败（退出码 ${String(failure?.code ?? "未知")}）`
  };
}

/** 最近一次探测的失败形态；成功即清空（能力缺失时上报给 CRM，让用户看到"为什么不可用"） */
const probeFailures: Record<CliKind, { missing: boolean; reason: string }> = {
  codex: { missing: false, reason: "" },
  workbuddy: { missing: false, reason: "" }
};

async function probeCliVersion(binary: string, args: string[], timeout: number, kind: CliKind, env?: NodeJS.ProcessEnv) {
  // codebuddy 启动时要拉远端配置，偶发超时；单次失败直接重试一次，避免把已具备的能力误报成缺失
  let failure = { missing: false, reason: "" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { stdout, stderr } = await execFileAsync(binary, args, { timeout, env });
      probeFailures[kind] = { missing: false, reason: "" };
      return `${stdout}${stderr}`.trim();
    } catch (error) {
      failure = describeProbeFailure(binary, error);
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  probeFailures[kind] = failure;
  return "";
}

export async function detectCodexVersion(binary = resolveCodexBinary()) {
  return (await probeCliVersion(binary, ["--version"], 8_000, "codex")).slice(0, 80);
}

/** 探测 WorkBuddy CLI（codebuddy）版本；未安装时返回空字符串，workbuddy 能力自动关闭 */
export async function detectWorkbuddyVersion(binary = resolveWorkbuddyBinary()) {
  const output = await probeCliVersion(binary, ["--version"], 20_000, "workbuddy", workbuddyProcessEnvironment());
  // 只取最后一行有效输出：--version 之外还可能混入远端配置告警
  return output.split("\n").map((line) => line.trim()).filter(Boolean).at(-1)?.slice(0, 80) || "";
}

/** CLI 探测结果缓存有效期；心跳每 10s 一次，没必要每次重跑两个 CLI 进程 */
const IDENTITY_TTL_MS = 5 * 60_000;
/**
 * 「刚掉线」后的快速重探间隔。账号切换（workbuddy switch）、CLI 重新登录、homebrew 升级把
 * 符号链接搞悬空，都是几十秒级的瞬时窗口：常态 5 分钟一轮探测够用，但**掉线恢复必须秒级** ——
 * 否则 CLI 明明已经能用，用户还要对着"CLI 不可用"干等 5 分钟。
 */
const RECOVERY_TTL_MS = 10_000;
/** 快速重探最多持续这么久，之后降到 DEGRADED_TTL_MS（仍持续能恢复，只是不那么频繁 fork） */
const RECOVERY_WINDOW_MS = 2 * 60_000;
/** 一直起不来（例如根本没装/长期故障）时的探测间隔 */
const DEGRADED_TTL_MS = 60_000;
/** 连续探测失败多少次后认定 CLI 真的不在了（否则一直挂着不可用的能力） */
const CLI_FAILURE_TOLERANCE = 3;

interface CliProbeState {
  version: string;
  failures: number;
  /** 历史上探到过：用于区分"掉线"（要快速重探）与"本机本来就没装"（不必空转 fork） */
  everDetected: boolean;
}

interface CliDetectionCache {
  at: number;
  codex: CliProbeState;
  workbuddy: CliProbeState;
  /** 进入"掉线快速重探"窗口的时刻；两端都正常时归零 */
  regressedAt: number;
}

let cliDetection: CliDetectionCache | null = null;
/** 心跳读的身份快照（见 cachedRunnerIdentity：心跳绝不允许阻塞在 CLI 探测上） */
let identitySnapshot: { key: string; identity: RunnerIdentity; at: number } | null = null;
let identityRefresh: Promise<RunnerIdentity | null> | null = null;

export function resetRunnerCliCache() {
  cliDetection = null;
  identitySnapshot = null;
  identityRefresh = null;
}

/**
 * 下一次心跳强制重新探测，但**保留上次成功值**（不清能力）：
 * 任务失败后调用 —— 账号切换之类的事件常常伴随一次失败，紧接着就该重新认识 CLI。
 * 与 resetRunnerCliCache 的区别：那个连"成功值粘滞"一起丢掉，只给测试用。
 */
export function invalidateRunnerCliCache() {
  if (cliDetection) cliDetection = { ...cliDetection, at: 0 };
}

/** 探测缓存的可读快照（诊断 / 测试用）：看得见"当前是否处于掉线快速重探窗口" */
export function cliDetectionSnapshot() {
  if (!cliDetection) return null;
  return {
    at: cliDetection.at,
    regressedAt: cliDetection.regressedAt,
    codex: { ...cliDetection.codex },
    workbuddy: { ...cliDetection.workbuddy }
  };
}

function carryOver(raw: string, previous: CliProbeState): CliProbeState {
  if (raw) return { version: raw, failures: 0, everDetected: true };
  const failures = previous.failures + 1;
  return {
    version: failures >= CLI_FAILURE_TOLERANCE ? "" : previous.version,
    failures,
    everDetected: previous.everDetected
  };
}

/** 能力当前缺失、且不是"本机没装"（装了但起不来 / 曾经能用现在断了）→ 值得快速重探 */
function recoverable(state: CliProbeState, kind: CliKind) {
  if (state.version) return false;
  if (state.everDetected) return true;
  // 没探到过，也不等于"本机没装"：二进制在、只是起不来（账号切换后 CLI 卡住 / 符号链接悬空）也算故障
  return !probeFailures[kind].missing && Boolean(probeFailures[kind].reason);
}

function capabilitiesFor(codexVersion: string, workbuddyVersion: string) {
  return [
    ...(codexVersion ? ["codex", "browser"] : []),
    ...(workbuddyVersion ? ["workbuddy"] : [])
  ];
}

/**
 * 探测本机 CLI 版本，带 TTL 缓存 + "成功值粘滞"。
 * 为什么要粘滞：`touchRunner` 会按上报值整体覆盖 capabilities，
 * 一次瞬时探测失败就会把 workbuddy/codex 能力从库存里抹掉（界面上的 CLI 选项随之消失）。
 * 为什么要"掉线快速重探"：能力一旦被抹掉，CRM 只认上一次心跳的结果，
 * 而账号切换/CLI 重启这类瞬时故障应当秒级自愈，不能让用户等一个 5 分钟 TTL。
 */
export async function detectRunnerClis(options: {
  ttlMs?: number;
  /** 掉线快速重探间隔（测试可缩短，默认 10s） */
  recoveryTtlMs?: number;
  force?: boolean;
  detectCodex?: () => Promise<string>;
  detectWorkbuddy?: () => Promise<string>;
} = {}) {
  const now = Date.now();
  if (!options.force && cliDetection) {
    const recovering = recoverable(cliDetection.codex, "codex") || recoverable(cliDetection.workbuddy, "workbuddy");
    const degraded = recovering && now - cliDetection.regressedAt >= RECOVERY_WINDOW_MS;
    const ttl = options.ttlMs
      ?? (recovering ? (degraded ? DEGRADED_TTL_MS : options.recoveryTtlMs ?? RECOVERY_TTL_MS) : IDENTITY_TTL_MS);
    if (now - cliDetection.at < ttl) {
      return { codexVersion: cliDetection.codex.version, workbuddyVersion: cliDetection.workbuddy.version };
    }
  }
  const [codexRaw, workbuddyRaw] = await Promise.all([
    (options.detectCodex || (() => detectCodexVersion()))().catch(() => ""),
    (options.detectWorkbuddy || (() => detectWorkbuddyVersion()))().catch(() => "")
  ]);
  const codex = carryOver(codexRaw, cliDetection?.codex || { version: "", failures: 0, everDetected: false });
  const workbuddy = carryOver(workbuddyRaw, cliDetection?.workbuddy || { version: "", failures: 0, everDetected: false });
  const regressed = recoverable(codex, "codex") || recoverable(workbuddy, "workbuddy");
  cliDetection = {
    at: now,
    codex,
    workbuddy,
    regressedAt: regressed ? (cliDetection?.regressedAt || now) : 0
  };
  return { codexVersion: codex.version, workbuddyVersion: workbuddy.version };
}

/**
 * 能力缺失时的探测失败原因（心跳 lastError 用）。返回空串表示"没有值得打扰用户的故障"：
 * 本机压根没装的 CLI 不算故障，装了却起不来的才算。
 */
export function runnerCliIssue() {
  const parts: string[] = [];
  for (const [kind, label] of [["codex", "Codex CLI"], ["workbuddy", "WorkBuddy CLI"]] as const) {
    const state = cliDetection?.[kind];
    const failure = probeFailures[kind];
    if (state && !state.version && failure.reason && !failure.missing) parts.push(`${label} 暂不可用：${failure.reason}`);
  }
  return parts.join("；");
}

export async function runnerIdentity(workspaces: string[]): Promise<RunnerIdentity> {
  const { codexVersion, workbuddyVersion } = await detectRunnerClis();
  const identity: RunnerIdentity = {
    hostname: hostname(),
    platform: `${platform()} ${release()}`,
    runnerVersion: RUNNER_VERSION,
    codexVersion,
    workbuddyVersion,
    capabilities: capabilitiesFor(codexVersion, workbuddyVersion),
    workspaces
  };
  identitySnapshot = { key: workspaces.join("|"), identity, at: Date.now() };
  return identity;
}

/** 后台刷新身份快照（并发去重）。CLI 探测自身有 TTL，所以这里可以每轮心跳都调一次。 */
function refreshRunnerIdentityInBackground(workspaces: string[]) {
  if (identityRefresh) return identityRefresh;
  identityRefresh = runnerIdentity(workspaces)
    .catch(() => null)
    .finally(() => { identityRefresh = null; });
  return identityRefresh;
}

/**
 * 心跳专用的身份快照：**绝不阻塞**。
 * CLI 探测要 fork 进程（`codebuddy --version` 正常 30ms，但账号切换/CLI 重启时可能卡到超时时间），
 * 而 CRM 侧「30 秒内没有心跳 = 这台 Runner 离线」。以前心跳是 `await runnerIdentity()` 之后才发，
 * 探测一慢就被判离线 —— 用户看到的就是"切了账号 CRM 就直接连不上"。
 * 这里返回最近一次快照，同时在后台按 TTL 刷新；还没有快照时返回 null，由调用方决定是否等一次。
 */
export function cachedRunnerIdentity(workspaces: string[]): RunnerIdentity | null {
  void refreshRunnerIdentityInBackground(workspaces);
  const key = workspaces.join("|");
  return identitySnapshot && identitySnapshot.key === key ? identitySnapshot.identity : null;
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
  // 任务期间的心跳同样只读快照：任务一开跑就 fork CLI，不能让它再叠加一次探测阻塞
  const identity = cachedRunnerIdentity(config.workspaces) || await runnerIdentity(config.workspaces);
  const heartbeat = setInterval(() => {
    void client.heartbeat({ ...identity, taskId: claim.task.id, leaseToken: claim.leaseToken })
      .then((state) => { if (!state.ok || state.cancelRequested) controller.abort(); })
      .catch(() => undefined);
  }, 8_000);
  heartbeat.unref();
  const publisher = eventPublisher(client, claim.task.id, claim.leaseToken);
  try {
    const isWorkbuddy = claim.task.adapter === "workbuddy";
    await client.event(claim.task.id, claim.leaseToken, { eventType: "status", message: isWorkbuddy ? "正在启动 WorkBuddy CLI" : "正在启动 Codex CLI" });
    const result = isWorkbuddy
      ? await executeWorkbuddyTask(claim.task, {
        allowedWorkspaces: config.workspaces,
        signal: controller.signal,
        onEvent: (event) => publisher.push(event)
      })
      : await executeCodexTask(claim.task, {
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
    // 失败可能意味着 CLI 环境变了（账号切换、重新登录、二进制被替换）。
    // 让下一轮心跳强制重新探测：能力该丢就丢、该回就回，不靠 5 分钟 TTL 猜。
    invalidateRunnerCliCache();
  } finally {
    clearInterval(heartbeat);
    outerSignal?.removeEventListener("abort", forwardAbort);
  }
  return true;
}

export async function startRunner(config: RunnerConfig, signal: AbortSignal) {
  const client = new GoodJobRunnerClient({ serverUrl: config.serverUrl, token: config.token });
  // 独立浏览器只在有 Codex 能力时才可能需要；纯 WorkBuddy CLI 的 Runner 不启动它，避免缺依赖时起不来。
  // ⚠️ 它**不是** Runner 的存活前提：起不来（端口被别的 Runner 占了最常见）只降级 + 上报，
  //    绝不能退出进程——否则 CRM 侧心跳还没过期，机器看着"在线"，任务却永远没人领。
  const identity = await runnerIdentity(config.workspaces);
  let browserService: Awaited<ReturnType<typeof tryStartBrowserService>>["service"] = null;
  let browserError = "";
  if (identity.capabilities.includes("codex")) {
    const started = await tryStartBrowserService();
    browserService = started.service;
    browserError = started.error;
    if (browserService) console.log(`[GoodJob Runner] 独立浏览器已就绪：${browserService.configuration.url}`);
    else console.error(`[GoodJob Runner] 独立浏览器不可用，Runner 继续运行（浏览器类任务会缺少受控浏览器）：${browserError}`);
  }
  let lastHeartbeat = 0;
  let lastBrowserHealth = 0;
  let failures = 0;
  try {
    while (!signal.aborted) {
      if (browserService && Date.now() - lastBrowserHealth > 10_000) {
        const [mcpReady, chromeReady] = await Promise.all([
          isBrowserServiceReachable(browserService.configuration),
          isBrowserCdpReady(browserService.configuration)
        ]);
        if (!mcpReady || !chromeReady) {
          // 浏览器挂了只回收浏览器，Runner 本体继续跑：workbuddy 任务完全不受影响
          browserError = "独立浏览器服务已停止";
          await browserService.stop().catch(() => undefined);
          browserService = null;
          console.error("[GoodJob Runner] 独立浏览器已停止，Runner 继续运行（浏览器类任务会缺少受控浏览器）");
        } else {
          lastBrowserHealth = Date.now();
        }
      }
      try {
        if (Date.now() - lastHeartbeat > 10_000) {
          // 心跳必须"零等待"：只读最近一次探测快照，CLI 探测在后台按 TTL 进行。
          // （旧写法 `await runnerIdentity()` 会在探测变慢时把心跳拖过 CRM 的 30s 在线窗口 → 被判离线。）
          // 还没有任何快照（进程刚起来）时才等一次。
          const identity = cachedRunnerIdentity(config.workspaces) || await runnerIdentity(config.workspaces);
          // lastError 同时承载"浏览器能力缺失"与"CLI 探测失败"，让 CRM 能显示这台机器为什么少了某项能力
          await client.heartbeat({ ...identity, lastError: [browserError, runnerCliIssue()].filter(Boolean).join("；") });
          lastHeartbeat = Date.now();
        }
        const handled = await runOneClaim(config, signal, browserService?.configuration.url || "");
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
    await browserService?.stop();
  }
}

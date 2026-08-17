import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { canSeeOwner } from "../auth.js";
import type { SessionUser } from "../types.js";
import type { LocalRunnerRepository, LocalRunnerVisibility } from "./local-runner-repository.js";
import type {
  LocalRunner,
  LocalRunnerExecutionMode,
  LocalRunnerTask,
  LocalRunnerTaskEvent
} from "./local-runner-types.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const future = (milliseconds: number) => new Date(Date.now() + milliseconds).toISOString();

function serviceError(code: string, message: string, status = 400): never {
  throw Object.assign(new Error(message), { code, status });
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizedWorkspaces(input: string[]) {
  return [...new Set(input.map((item) => item.trim()).filter((item) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(item) && item.length <= 1000))].slice(0, 20);
}

const knownCapabilities = (input: string[]) => [
  ...new Set(input.filter((item) => item === "codex" || item === "browser"))
];

function publicRunner(runner: LocalRunner) {
  const online = runner.status === "active" && Boolean(runner.lastSeenAt)
    && Date.now() - new Date(runner.lastSeenAt).getTime() < 30_000;
  return {
    id: runner.id, teamId: runner.teamId, ownerId: runner.ownerId, displayName: runner.displayName,
    status: runner.status, online, hostname: runner.hostname, platform: runner.platform,
    runnerVersion: runner.runnerVersion, codexVersion: runner.codexVersion,
    capabilities: runner.capabilities, workspaces: runner.workspaces, lastSeenAt: runner.lastSeenAt,
    lastError: runner.lastError, createdAt: runner.createdAt, updatedAt: runner.updatedAt,
    revokedAt: runner.revokedAt
  };
}

function publicTask(task: LocalRunnerTask) {
  const { leaseHash: _leaseHash, ...safe } = task;
  return safe;
}

export class LocalRunnerService {
  constructor(private readonly repository: LocalRunnerRepository) {}

  private visibility(actor: SessionUser): LocalRunnerVisibility {
    if (actor.iamDataScope?.tenantWide) return { teamId: actor.teamId };
    const ownerIds = actor.iamDataScope?.ownerIds?.filter(Boolean) || [actor.id];
    return { teamId: actor.teamId, ownerIds: [...new Set([actor.id, ...ownerIds])] };
  }

  private canAccess(actor: SessionUser, ownerId: string, teamId: string) {
    if (teamId !== actor.teamId) return false;
    if (ownerId === actor.id) return true;
    if (actor.iamDataScope?.tenantWide) return true;
    if (actor.iamDataScope?.ownerIds?.includes(ownerId)) return true;
    return actor.iamDataScope ? false : canSeeOwner(actor, ownerId, teamId);
  }

  async createPairing(actor: SessionUser, deviceName: string) {
    const raw = randomBytes(6).toString("hex").toUpperCase();
    const code = `GJ-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
    const createdAt = now();
    const expiresAt = future(10 * 60_000);
    await this.repository.createPairing({
      id: `lrp_${randomUUID()}`, codeHash: sha256(code), teamId: actor.teamId,
      ownerId: actor.id, createdBy: actor.id, deviceName: deviceName.trim() || "我的电脑",
      expiresAt, consumedAt: "", runnerId: "", createdAt
    });
    return { pairingCode: code, expiresAt };
  }

  async pair(input: {
    code: string; displayName: string; hostname: string; platform: string; runnerVersion: string;
    codexVersion: string; capabilities: string[]; workspaces: string[];
  }) {
    const runnerId = `lrr_${randomUUID()}`;
    const secret = randomBytes(32).toString("base64url");
    const token = `gjr_${runnerId}.${secret}`;
    const createdAt = now();
    const runner: LocalRunner = {
      id: runnerId, teamId: "", ownerId: "", displayName: input.displayName.trim().slice(0, 160) || "GoodJob Runner",
      status: "active", tokenHash: sha256(token), tokenFingerprint: sha256(token).slice(0, 12),
      hostname: input.hostname.slice(0, 200), platform: input.platform.slice(0, 80),
      runnerVersion: input.runnerVersion.slice(0, 40), codexVersion: input.codexVersion.slice(0, 80),
      capabilities: knownCapabilities(input.capabilities),
      workspaces: normalizedWorkspaces(input.workspaces), lastSeenAt: createdAt, lastError: "",
      createdAt, updatedAt: createdAt, revokedAt: ""
    };
    if (!runner.workspaces.length) serviceError("LOCAL_RUNNER_WORKSPACE_REQUIRED", "至少需要授权一个绝对路径工作目录");
    const pairing = await this.repository.consumePairing({ codeHash: sha256(input.code.trim().toUpperCase()), runner });
    if (!pairing) serviceError("LOCAL_RUNNER_PAIRING_INVALID", "配对码无效、已使用或已过期", 401);
    return { runner: publicRunner({ ...runner, teamId: pairing.teamId, ownerId: pairing.ownerId }), token };
  }

  async authenticate(rawToken: string) {
    const match = rawToken.match(/^gjr_(lrr_[0-9a-f-]{36})\.([A-Za-z0-9_-]{32,})$/u);
    if (!match) serviceError("LOCAL_RUNNER_TOKEN_INVALID", "Runner 凭证无效", 401);
    const runner = await this.repository.getRunner(match[1]);
    if (!runner || runner.status !== "active" || !runner.tokenHash || !safeEqual(runner.tokenHash, sha256(rawToken))) {
      serviceError("LOCAL_RUNNER_TOKEN_INVALID", "Runner 凭证无效或已撤销", 401);
    }
    return runner;
  }

  async runners(actor: SessionUser) {
    return (await this.repository.listRunners(this.visibility(actor))).map(publicRunner);
  }

  async revoke(actor: SessionUser, id: string) {
    const runner = await this.repository.getRunner(id);
    if (!runner || !this.canAccess(actor, runner.ownerId, runner.teamId)) serviceError("LOCAL_RUNNER_NOT_FOUND", "Runner 不存在或无权访问", 404);
    await this.repository.revokeRunner(id);
    return publicRunner({ ...runner, status: "revoked", revokedAt: now(), updatedAt: now(), tokenHash: "" });
  }

  async heartbeat(runner: LocalRunner, input: {
    hostname?: string; platform?: string; runnerVersion?: string; codexVersion?: string;
    capabilities?: string[]; workspaces?: string[]; lastError?: string; taskId?: string; leaseToken?: string;
  }) {
    const reportedWorkspaces = input.workspaces ? normalizedWorkspaces(input.workspaces) : undefined;
    const reducedWorkspaces = reportedWorkspaces?.filter((workspace) => runner.workspaces.includes(workspace));
    const reportedCapabilities = input.capabilities ? knownCapabilities(input.capabilities) : undefined;
    await this.repository.touchRunner(runner.id, {
      hostname: input.hostname?.slice(0, 200), platform: input.platform?.slice(0, 80),
      runnerVersion: input.runnerVersion?.slice(0, 40), codexVersion: input.codexVersion?.slice(0, 80),
      capabilities: reportedCapabilities,
      workspaces: reducedWorkspaces?.length ? reducedWorkspaces : undefined,
      lastError: input.lastError?.slice(0, 1000)
    });
    if (!input.taskId || !input.leaseToken) return { ok: true, cancelRequested: false };
    return this.repository.heartbeatTask(input.taskId, runner.id, sha256(input.leaseToken), future(30_000));
  }

  async createTask(actor: SessionUser, input: {
    runnerId: string; prompt: string; workspace: string; executionMode: LocalRunnerExecutionMode; timeoutSeconds: number;
  }) {
    const runner = await this.repository.getRunner(input.runnerId);
    if (!runner || runner.status !== "active" || !this.canAccess(actor, runner.ownerId, runner.teamId)) {
      serviceError("LOCAL_RUNNER_NOT_FOUND", "Runner 不存在、已停用或无权访问", 404);
    }
    if (!runner.workspaces.includes(input.workspace)) {
      serviceError("LOCAL_RUNNER_WORKSPACE_DENIED", "该工作目录未在本机 Runner 授权范围内", 403);
    }
    if (!runner.capabilities.includes("codex")) serviceError("LOCAL_RUNNER_CODEX_UNAVAILABLE", "该 Runner 未检测到 Codex CLI", 409);
    const createdAt = now();
    const task: LocalRunnerTask = {
      id: `lrt_${randomUUID()}`, runnerId: runner.id, teamId: runner.teamId, ownerId: runner.ownerId,
      createdBy: actor.id, adapter: "codex", prompt: input.prompt.trim(), workspace: input.workspace,
      executionMode: input.executionMode, timeoutSeconds: Math.max(30, Math.min(1800, input.timeoutSeconds)),
      status: "queued", attemptCount: 0, leaseHash: "", leaseExpiresAt: "", cancelRequestedAt: "",
      resultText: "", errorMessage: "", outputTruncated: false, codexThreadId: "",
      createdAt, queuedAt: createdAt, startedAt: "", finishedAt: "", updatedAt: createdAt
    };
    if (!task.prompt || task.prompt.length > 20_000) serviceError("LOCAL_RUNNER_PROMPT_INVALID", "任务内容不能为空且不能超过 20000 个字符");
    await this.repository.createTask(task);
    await this.repository.appendEvent({
      taskId: task.id, runnerId: task.runnerId, teamId: task.teamId, ownerId: task.ownerId,
      eventType: "status", message: "任务已进入本地执行队列", payload: {}, createdAt
    });
    return publicTask(task);
  }

  async tasks(actor: SessionUser, runnerId = "") {
    await this.repository.recoverStaleTasks();
    return (await this.repository.listTasks(this.visibility(actor), runnerId, 100)).map(publicTask);
  }

  async task(actor: SessionUser, id: string) {
    await this.repository.recoverStaleTasks();
    const task = await this.repository.getTask(id);
    if (!task || !this.canAccess(actor, task.ownerId, task.teamId)) serviceError("LOCAL_RUNNER_TASK_NOT_FOUND", "任务不存在或无权访问", 404);
    return { task: publicTask(task), events: await this.repository.listTaskEvents(id, 300) };
  }

  async cancel(actor: SessionUser, id: string) {
    const task = await this.repository.getTask(id);
    if (!task || !this.canAccess(actor, task.ownerId, task.teamId)) serviceError("LOCAL_RUNNER_TASK_NOT_FOUND", "任务不存在或无权访问", 404);
    if (!["queued", "running"].includes(task.status)) return publicTask(task);
    const updated = await this.repository.cancelTask(id);
    if (!updated) serviceError("LOCAL_RUNNER_TASK_CONFLICT", "任务状态已变化，请刷新后重试", 409);
    await this.repository.appendEvent({
      taskId: task.id, runnerId: task.runnerId, teamId: task.teamId, ownerId: task.ownerId,
      eventType: "status", message: task.status === "queued" ? "任务已取消" : "已请求本机停止任务",
      payload: {}, createdAt: now()
    });
    return publicTask(updated);
  }

  async claim(runner: LocalRunner) {
    await this.repository.touchRunner(runner.id, {});
    await this.repository.recoverStaleTasks(runner.id);
    const leaseToken = randomBytes(32).toString("base64url");
    const task = await this.repository.claimTask(runner.id, sha256(leaseToken), future(30_000));
    if (!task) return null;
    await this.repository.appendEvent({
      taskId: task.id, runnerId: task.runnerId, teamId: task.teamId, ownerId: task.ownerId,
      eventType: "status", message: "本地 Runner 已领取任务", payload: { attempt: task.attemptCount }, createdAt: now()
    });
    return { task: publicTask(task), leaseToken };
  }

  async appendEvent(runner: LocalRunner, taskId: string, leaseToken: string, input: {
    eventType: LocalRunnerTaskEvent["eventType"]; message: string; payload?: Record<string, unknown>;
  }) {
    return this.appendEvents(runner, taskId, leaseToken, [input]);
  }

  async appendEvents(runner: LocalRunner, taskId: string, leaseToken: string, inputs: Array<{
    eventType: LocalRunnerTaskEvent["eventType"]; message: string; payload?: Record<string, unknown>;
  }>) {
    const task = await this.repository.getTask(taskId);
    if (!task || task.runnerId !== runner.id || !task.leaseHash || !safeEqual(task.leaseHash, sha256(leaseToken))) {
      serviceError("LOCAL_RUNNER_LEASE_INVALID", "任务租约无效或已过期", 409);
    }
    const createdAt = Date.now();
    await this.repository.appendEvents(inputs.slice(0, 50).map((input, index) => ({
      taskId, runnerId: runner.id, teamId: task.teamId, ownerId: task.ownerId,
      eventType: input.eventType, message: input.message.slice(0, 8000), payload: input.payload || {},
      createdAt: new Date(createdAt + index).toISOString()
    })));
    return { ok: true };
  }

  async complete(runner: LocalRunner, taskId: string, leaseToken: string, input: {
    status: "succeeded" | "failed" | "cancelled"; resultText: string; errorMessage: string;
    outputTruncated: boolean; codexThreadId: string;
  }) {
    const task = await this.repository.getTask(taskId);
    if (!task || task.runnerId !== runner.id) serviceError("LOCAL_RUNNER_TASK_NOT_FOUND", "任务不存在", 404);
    const status = task.status === "cancelling" ? "cancelled" : input.status;
    const completed = await this.repository.completeTask({
      taskId, runnerId: runner.id, leaseHash: sha256(leaseToken), status,
      resultText: input.resultText.slice(0, 200_000), errorMessage: input.errorMessage.slice(0, 4000),
      outputTruncated: input.outputTruncated || input.resultText.length > 200_000,
      codexThreadId: input.codexThreadId.slice(0, 100)
    });
    if (!completed) serviceError("LOCAL_RUNNER_LEASE_INVALID", "任务租约无效或任务状态已变化", 409);
    await this.repository.appendEvent({
      taskId, runnerId: runner.id, teamId: task.teamId, ownerId: task.ownerId,
      eventType: status === "succeeded" ? "status" : status === "cancelled" ? "warning" : "error",
      message: status === "succeeded" ? "Codex CLI 已完成任务" : status === "cancelled" ? "任务已停止" : "Codex CLI 执行失败",
      payload: { status }, createdAt: now()
    });
    return { ok: true, status };
  }
}

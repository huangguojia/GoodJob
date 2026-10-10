import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import type { SessionUser } from "../types.js";
import { ensureIntegrationSchema } from "./integration-mysql-schema.js";
import { MysqlLocalRunnerRepository } from "./local-runner-repository.js";
import { LocalRunnerService } from "./local-runner-service.js";

const databaseUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
if (!databaseUrl) throw new Error("local runner MySQL test requires DATABASE_URL");
const pool = mysql.createPool(databaseUrl);
await ensureIntegrationSchema(pool);

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
const teamA = `runner_team_a_${suffix}`;
const teamB = `runner_team_b_${suffix}`;
const actor = (id: string, teamId: string): SessionUser => ({
  id, teamId, name: id, email: `${id}@example.test`, role: "admin", avatar: "A", authVersion: 1,
  iamDataScope: { permissionCode: "integration.execute", tenantWide: false, ownerIds: [id] }
});
const ownerA = actor(`runner_owner_a_${suffix}`, teamA);
const ownerB = actor(`runner_owner_b_${suffix}`, teamB);
const repository = new MysqlLocalRunnerRepository(pool);
const service = new LocalRunnerService(repository);

try {
  const pairing = await service.createPairing(ownerA, "My Mac");
  await assert.rejects(() => service.pair({
    code: "GJ-WRONG-CODE-00", displayName: "Wrong", hostname: "wrong", platform: "test",
    runnerVersion: "test", codexVersion: "codex-test", workbuddyVersion: "", capabilities: ["codex"], workspaces: ["/tmp"]
  }), /配对码无效/u);
  const paired = await service.pair({
    code: pairing.pairingCode, displayName: "My Mac", hostname: "mac-test", platform: "darwin",
    runnerVersion: "0.1.0", codexVersion: "codex-cli test", workbuddyVersion: "codebuddy 2.156.0",
    capabilities: ["codex", "workbuddy"], workspaces: ["/tmp"]
  });
  const storedRunner = await repository.getRunner(paired.runner.id);
  assert.ok(storedRunner);
  assert.notEqual(storedRunner?.tokenHash, paired.token);
  assert.equal(storedRunner?.workbuddyVersion, "codebuddy 2.156.0", "pair must persist workbuddy version");
  assert.equal(paired.runner.workbuddyVersion, "codebuddy 2.156.0", "pair response must expose workbuddy version");
  assert.equal((await service.authenticate(paired.token)).id, paired.runner.id);
  assert.equal((await service.runners(ownerB)).length, 0, "other tenant must not see runner");
  await service.heartbeat(storedRunner!, {
    capabilities: ["codex", "browser", "workbuddy", "unknown"],
    workspaces: ["/tmp", "/etc"]
  });
  const heartbeatRunner = await repository.getRunner(paired.runner.id);
  assert.deepEqual(heartbeatRunner?.capabilities, ["codex", "browser", "workbuddy"], "heartbeat must refresh known capabilities");
  assert.deepEqual(heartbeatRunner?.workspaces, ["/tmp"], "heartbeat must not expand workspace allowlist");

  await assert.rejects(() => service.createTask(ownerB, {
    runnerId: paired.runner.id, prompt: "cross tenant", workspace: "/tmp", executionMode: "read_only", timeoutSeconds: 60
  }), /无权访问/u);
  const task = await service.createTask(ownerA, {
    runnerId: paired.runner.id, prompt: "Return closed-loop result", workspace: "/tmp",
    executionMode: "read_only", timeoutSeconds: 60
  });
  const claim = await service.claim((await service.authenticate(paired.token)));
  assert.equal(claim?.task.id, task.id);
  assert.ok(claim?.leaseToken);
  await assert.rejects(() => service.appendEvent((storedRunner!), task.id, "wrong-lease-token-value-123456789", {
    eventType: "progress", message: "must fail"
  }), /租约无效/u);
  await service.appendEvents(storedRunner!, task.id, claim!.leaseToken, [
    { eventType: "progress", message: "command started", payload: { stage: "command" } },
    { eventType: "output", message: "CLI result", payload: { stage: "message" } }
  ]);
  const heartbeat = await service.heartbeat(storedRunner!, { taskId: task.id, leaseToken: claim!.leaseToken });
  assert.equal(heartbeat.ok, true);
  await service.complete(storedRunner!, task.id, claim!.leaseToken, {
    status: "succeeded", resultText: "CLI result", errorMessage: "", outputTruncated: false, codexThreadId: "thread-test"
  });
  const detail = await service.task(ownerA, task.id);
  assert.equal(detail.task.status, "succeeded");
  assert.equal(detail.task.resultText, "CLI result");
  assert.ok(detail.events.some((event) => event.message === "CLI result"));
  assert.ok(detail.events.findIndex((event) => event.message === "command started") < detail.events.findIndex((event) => event.message === "CLI result"));

  const parallelA = await service.createTask(ownerA, {
    runnerId: paired.runner.id, prompt: "parallel A", workspace: "/tmp", executionMode: "read_only", timeoutSeconds: 60
  });
  const parallelB = await service.createTask(ownerA, {
    runnerId: paired.runner.id, prompt: "parallel B", workspace: "/tmp", executionMode: "read_only", timeoutSeconds: 60
  });
  const parallelClaims = await Promise.all([service.claim(storedRunner!), service.claim(storedRunner!)]);
  assert.equal(parallelClaims.filter(Boolean).length, 1, "one runner must claim at most one active task");
  const activeClaim = parallelClaims.find(Boolean)!;
  await service.complete(storedRunner!, activeClaim.task.id, activeClaim.leaseToken, {
    status: "succeeded", resultText: "parallel complete", errorMessage: "", outputTruncated: false, codexThreadId: ""
  });
  await service.cancel(ownerA, activeClaim.task.id === parallelA.id ? parallelB.id : parallelA.id);

  const cancelled = await service.createTask(ownerA, {
    runnerId: paired.runner.id, prompt: "cancel me", workspace: "/tmp", executionMode: "workspace_write", timeoutSeconds: 60
  });
  assert.equal((await service.cancel(ownerA, cancelled.id)).status, "cancelled");

  // —— WorkBuddy 适配器与 24 小时超时 ——
  const workbuddyTask = await service.createTask(ownerA, {
    runnerId: paired.runner.id, prompt: "WorkBuddy 任务", workspace: "/tmp",
    executionMode: "read_only", timeoutSeconds: 86_400, adapter: "workbuddy"
  });
  assert.equal(workbuddyTask.adapter, "workbuddy", "task must keep requested adapter");
  assert.equal(workbuddyTask.timeoutSeconds, 86_400, "task must accept a 24 hour timeout");
  const reloadedWorkbuddy = await service.task(ownerA, workbuddyTask.id);
  assert.equal(reloadedWorkbuddy.task.adapter, "workbuddy", "adapter must round-trip through MySQL");
  assert.ok(reloadedWorkbuddy.events.some((event) => event.message.includes("WorkBuddy CLI")), "queue event must name the WorkBuddy adapter");
  assert.equal((await service.cancel(ownerA, workbuddyTask.id)).status, "cancelled");

  const overCapTask = await service.createTask(ownerA, {
    runnerId: paired.runner.id, prompt: "clamp timeout", workspace: "/tmp",
    executionMode: "read_only", timeoutSeconds: 86_400 * 3, adapter: "codex"
  });
  assert.equal(overCapTask.timeoutSeconds, 86_400, "timeout must be capped at 24 hours");
  await service.cancel(ownerA, overCapTask.id);

  await service.heartbeat(storedRunner!, { capabilities: ["codex"] });
  await assert.rejects(() => service.createTask(ownerA, {
    runnerId: paired.runner.id, prompt: "no workbuddy", workspace: "/tmp",
    executionMode: "read_only", timeoutSeconds: 60, adapter: "workbuddy"
  }), /未检测到 WorkBuddy CLI/u);
  await service.heartbeat(storedRunner!, { capabilities: ["codex", "workbuddy"] });
  assert.equal((await repository.getRunner(paired.runner.id))?.capabilities.includes("workbuddy"), true, "workbuddy capability must be restorable");

  await service.revoke(ownerA, paired.runner.id);
  await assert.rejects(() => service.authenticate(paired.token), /已撤销/u);

  console.log(JSON.stringify({
    ok: true,
    pairingTokenHashed: true,
    tenantIsolation: true,
    workspaceAllowlist: true,
    atomicClaimLease: true,
    singleActiveTaskPerRunner: true,
    heartbeatRefreshesKnownCapabilities: true,
    heartbeatCannotExpandWorkspace: true,
    orderedEventBatching: true,
    heartbeatAndCompletion: true,
    queuedCancellation: true,
    revocation: true,
    workbuddyAdapterRoundTrip: true,
    adapterCapabilityGate: true,
    twentyFourHourTimeoutCap: true
  }, null, 2));
} finally {
  await pool.execute("DELETE FROM integration_local_runner_task_events WHERE team_id IN (?,?)", [teamA, teamB]);
  await pool.execute("DELETE FROM integration_local_runner_tasks WHERE team_id IN (?,?)", [teamA, teamB]);
  await pool.execute("DELETE FROM integration_local_runners WHERE team_id IN (?,?)", [teamA, teamB]);
  await pool.execute("DELETE FROM integration_local_runner_pairings WHERE team_id IN (?,?)", [teamA, teamB]);
  await pool.end();
}

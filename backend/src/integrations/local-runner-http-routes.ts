import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { getLocalRunnerService } from "./integration-runtime.js";

const agentRouter = Router();
const webRouter = Router();

const pairingLimiter = rateLimit({
  windowMs: 60_000,
  limit: process.env.NODE_ENV === "test" ? 10_000 : 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "配对尝试过于频繁，请稍后再试" }
});

function service() {
  const value = getLocalRunnerService();
  if (!value) throw Object.assign(new Error("本地 Runner 服务需要 MySQL 持久化"), { status: 503, code: "LOCAL_RUNNER_UNAVAILABLE" });
  return value;
}

function requestId(req: Request) {
  return String(req.headers["x-request-id"] || `runner_${Date.now().toString(36)}`);
}

function handle(work: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try {
      await work(req, res);
    } catch (error) {
      const value = error as { status?: number; code?: string; message?: string; issues?: unknown };
      res.status(value.status || (value.issues ? 400 : 500)).json({
        requestId: requestId(req),
        errorCode: value.code || (value.issues ? "LOCAL_RUNNER_INPUT_INVALID" : "LOCAL_RUNNER_INTERNAL_ERROR"),
        message: value.message || "本地 Runner 请求失败"
      });
    }
  };
}

function envelope(req: Request, res: Response, data: unknown, status = 200) {
  res.status(status).json({ requestId: requestId(req), data });
}

function runnerToken(req: Request) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^(?:Bearer|Runner)\s+(.+)$/iu);
  return match?.[1]?.trim() || "";
}

const agentIdentity = z.object({
  hostname: z.string().trim().max(200).default(""),
  platform: z.string().trim().max(80).default(""),
  runnerVersion: z.string().trim().max(40).default(""),
  codexVersion: z.string().trim().max(80).default(""),
  capabilities: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  workspaces: z.array(z.string().trim().min(1).max(1000)).max(20).default([])
});

const taskEventInput = z.object({
  eventType: z.enum(["status", "progress", "output", "warning", "error"]),
  message: z.string().max(8000),
  payload: z.record(z.string(), z.unknown()).optional()
}).strict();

agentRouter.post("/runner-agent/pair", pairingLimiter, handle(async (req, res) => {
  const body = agentIdentity.extend({
    code: z.string().trim().min(8).max(32),
    displayName: z.string().trim().min(1).max(160)
  }).strict().parse(req.body);
  res.status(201).json(await service().pair(body));
}));

agentRouter.post("/runner-agent/claim", handle(async (req, res) => {
  z.object({}).strict().parse(req.body || {});
  const runner = await service().authenticate(runnerToken(req));
  res.json({ claim: await service().claim(runner) });
}));

agentRouter.post("/runner-agent/heartbeat", handle(async (req, res) => {
  const body = agentIdentity.partial().extend({
    lastError: z.string().max(1000).optional(),
    taskId: z.string().max(64).optional(),
    leaseToken: z.string().max(200).optional()
  }).strict().parse(req.body || {});
  const runner = await service().authenticate(runnerToken(req));
  res.json(await service().heartbeat(runner, body));
}));

agentRouter.post("/runner-agent/tasks/:id/events", handle(async (req, res) => {
  const body = taskEventInput.extend({ leaseToken: z.string().min(20).max(200) }).strict().parse(req.body);
  const runner = await service().authenticate(runnerToken(req));
  res.status(201).json(await service().appendEvent(runner, req.params.id, body.leaseToken, body));
}));

agentRouter.post("/runner-agent/tasks/:id/events/batch", handle(async (req, res) => {
  const body = z.object({
    leaseToken: z.string().min(20).max(200),
    events: z.array(taskEventInput).min(1).max(50)
  }).strict().parse(req.body);
  const runner = await service().authenticate(runnerToken(req));
  res.status(201).json(await service().appendEvents(runner, req.params.id, body.leaseToken, body.events));
}));

agentRouter.post("/runner-agent/tasks/:id/complete", handle(async (req, res) => {
  const body = z.object({
    leaseToken: z.string().min(20).max(200),
    status: z.enum(["succeeded", "failed", "cancelled"]),
    resultText: z.string().max(220_000).default(""),
    errorMessage: z.string().max(4000).default(""),
    outputTruncated: z.boolean().default(false),
    codexThreadId: z.string().max(100).default("")
  }).strict().parse(req.body);
  const runner = await service().authenticate(runnerToken(req));
  res.json(await service().complete(runner, req.params.id, body.leaseToken, body));
}));

webRouter.get("/local-runners", handle(async (req, res) => {
  envelope(req, res, await service().runners(req.user!));
}));

webRouter.post("/local-runners/pairings", handle(async (req, res) => {
  const body = z.object({ deviceName: z.string().trim().max(160).default("我的电脑") }).strict().parse(req.body || {});
  const pairing = await service().createPairing(req.user!, body.deviceName);
  const publicBase = String(process.env.GOODJOB_PUBLIC_URL || `${req.protocol}://${req.get("host") || "localhost:4188"}`).replace(/\/$/u, "");
  envelope(req, res, {
    ...pairing,
    command: `goodjob-runner pair --server ${JSON.stringify(publicBase)} --code ${JSON.stringify(pairing.pairingCode)} --workspace ${JSON.stringify("/path/to/workspace")}`
  }, 201);
}));

webRouter.post("/local-runners/:id/revoke", handle(async (req, res) => {
  z.object({}).strict().parse(req.body || {});
  envelope(req, res, await service().revoke(req.user!, req.params.id));
}));

webRouter.get("/local-runner-tasks", handle(async (req, res) => {
  const runnerId = z.string().max(64).default("").parse(req.query.runnerId || "");
  envelope(req, res, await service().tasks(req.user!, runnerId));
}));

webRouter.post("/local-runner-tasks", handle(async (req, res) => {
  const body = z.object({
    runnerId: z.string().min(1).max(64),
    prompt: z.string().trim().min(1).max(20_000),
    workspace: z.string().min(1).max(1000),
    executionMode: z.enum(["read_only", "workspace_write"]).default("read_only"),
    timeoutSeconds: z.number().int().min(30).max(1800).default(600)
  }).strict().parse(req.body);
  envelope(req, res, await service().createTask(req.user!, body), 201);
}));

webRouter.get("/local-runner-tasks/:id", handle(async (req, res) => {
  envelope(req, res, await service().task(req.user!, req.params.id));
}));

webRouter.post("/local-runner-tasks/:id/cancel", handle(async (req, res) => {
  z.object({}).strict().parse(req.body || {});
  envelope(req, res, await service().cancel(req.user!, req.params.id));
}));

export { agentRouter as localRunnerAgentRouter, webRouter as localRunnerWebRouter };

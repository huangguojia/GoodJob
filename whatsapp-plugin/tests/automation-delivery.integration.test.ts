import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppRuntime, type AppRuntime } from "../src/server/app";
import { AutomationRhythmService } from "../src/server/services/automation-rhythm";
import { ConversationIntelligenceService } from "../src/server/services/conversation-intelligence";

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

describe("automation CRM delivery", () => {
  let crmServer: Server;
  let crmBaseUrl = "";
  let runtime: AppRuntime;
  let failNextTodo = true;
  const todos = new Map<string, Record<string, unknown>>();
  const notifications = new Map<string, Record<string, unknown>>();

  const crmHandler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/api/customers") {
      response.end(JSON.stringify({ customers: [{ id: "crm-customer-42", whatsappPhone: "+34 612 140 788" }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/todos") {
      const body = await readJson(request);
      if (failNextTodo) {
        failNextTodo = false;
        response.statusCode = 503;
        response.end(JSON.stringify({ message: "CRM 暂时不可用" }));
        return;
      }
      const triggerKey = String(body.triggerKey);
      const existing = todos.get(triggerKey);
      if (existing) {
        response.end(JSON.stringify({ todo: existing, deduplicated: true }));
        return;
      }
      const todo = { id: `todo-${todos.size + 1}`, ...body };
      todos.set(triggerKey, todo);
      response.statusCode = 201;
      response.end(JSON.stringify({ todo }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/internal-messages/system") {
      const body = await readJson(request);
      const idempotencyKey = String(body.idempotencyKey);
      const existing = notifications.get(idempotencyKey);
      if (existing) {
        response.end(JSON.stringify({ message: existing, deduplicated: true }));
        return;
      }
      const message = { id: `message-${notifications.size + 1}`, ...body };
      notifications.set(idempotencyKey, message);
      response.statusCode = 201;
      response.end(JSON.stringify({ message }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "Not found" }));
  };

  beforeAll(async () => {
    crmServer = createServer((request, response) => void crmHandler(request, response));
    await new Promise<void>((resolve) => crmServer.listen(0, "127.0.0.1", resolve));
    const address = crmServer.address();
    if (!address || typeof address === "string") throw new Error("CRM mock did not bind to a port");
    crmBaseUrl = `http://127.0.0.1:${address.port}`;
    const directory = await mkdtemp(path.join(os.tmpdir(), "wa-automation-delivery-test-"));
    runtime = await createAppRuntime({
      nodeEnv: "test",
      port: 0,
      webOrigin: "http://localhost:5173",
      databaseClient: "pglite",
      pglitePath: path.join(directory, "pgdata"),
      sessionMasterKey: randomBytes(32).toString("base64"),
      seedDemo: false,
      allowPrivateAiEndpoints: false
    });
  });

  afterAll(async () => {
    await runtime.close();
    await new Promise<void>((resolve, reject) => crmServer.close((error) => error ? reject(error) : resolve()));
  });

  it("links customers, deduplicates across days and retries failed writes", async () => {
    const ownerUserId = "crm-owner-automation";
    const account = await runtime.repository.createAccount({
      name: "Automation Test",
      provider: "demo",
      riskAccepted: true,
      ownerUserId
    });
    const contact = await runtime.repository.upsertContact({
      accountId: account.id,
      providerContactId: "34612140788@s.whatsapp.net",
      displayName: "Sofia Martinez",
      phone: "+34612140788",
      source: "demo"
    });
    const conversation = await runtime.repository.ensureConversationForContact(contact.id);
    await runtime.repository.createMessage({
      accountId: account.id,
      conversationId: conversation.id,
      providerMessageId: "automation-inbound-1",
      direction: "inbound",
      body: "Please send your price for 500 units.",
      status: "delivered"
    });

    const realtime = { publish: () => undefined } as never;
    const intelligence = new ConversationIntelligenceService(runtime.repository, realtime);
    let currentTime = new Date("2026-08-09T01:00:00.000Z");
    const automation = new AutomationRhythmService(runtime.repository, intelligence, crmBaseUrl, "automation-test-secret-at-least-32-characters", () => currentTime);

    await expect(automation.runNow(ownerUserId)).rejects.toThrow("CRM 交付失败 1 项");
    expect(todos.size).toBe(1);
    expect(notifications.size).toBe(2);
    const failedDeliveries = await runtime.database.query<{ status: string; attempts: number; last_error: string | null }>(
      "SELECT status,attempts,last_error FROM automation_deliveries WHERE owner_user_id=$1 AND delivery_type='todo' ORDER BY created_at",
      [ownerUserId]
    );
    expect(failedDeliveries.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "failed", attempts: 1, last_error: "CRM 暂时不可用" })
    ]));

    const retried = await automation.runNow(ownerUserId);
    expect(retried.todosCreated).toBe(1);
    expect(retried.notificationsSent).toBe(0);
    expect(retried.skipped).toBe(3);
    expect(todos.size).toBe(2);
    expect(notifications.size).toBe(2);
    const retriedDeliveries = await runtime.database.query<{ status: string; attempts: number; external_id: string | null }>(
      "SELECT status,attempts,external_id FROM automation_deliveries WHERE owner_user_id=$1 AND delivery_type='todo' ORDER BY created_at",
      [ownerUserId]
    );
    expect(retriedDeliveries.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "success", attempts: 2, external_id: expect.stringMatching(/^todo-/u) })
    ]));
    for (const todo of todos.values()) {
      expect(todo).toMatchObject({ customerId: "crm-customer-42" });
      expect(todo.triggerKey).toMatch(/^whatsapp-insight:crm-customer-42:/u);
    }

    const sameDay = await automation.runNow(ownerUserId);
    expect(sameDay).toMatchObject({ todosCreated: 0, notificationsSent: 0, skipped: 4 });
    expect(todos.size).toBe(2);
    expect(notifications.size).toBe(2);

    currentTime = new Date("2026-08-10T01:00:00.000Z");
    const nextDay = await automation.runNow(ownerUserId);
    expect(nextDay).toMatchObject({ todosCreated: 0, notificationsSent: 2, skipped: 2 });
    expect(todos.size).toBe(2);
    expect(notifications.size).toBe(4);
  });
});

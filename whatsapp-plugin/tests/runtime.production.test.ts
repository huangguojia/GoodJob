import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppRuntime, type AppRuntime } from "../src/server/app";

describe("production runtime boundaries", () => {
  let runtime: AppRuntime;

  beforeAll(async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wa-crm-runtime-test-"));
    runtime = await createAppRuntime({
      nodeEnv: "test",
      port: 0,
      webOrigin: "http://localhost:5173",
      databaseClient: "pglite",
      pglitePath: path.join(directory, "pgdata"),
      sessionMasterKey: randomBytes(32).toString("base64"),
      seedDemo: false,
      enableDemoProvider: false,
      autoMigrate: true,
      officialOnly: true,
      allowPrivateAiEndpoints: false
    });
  }, 30_000);

  afterAll(async () => {
    await runtime.close();
  });

  it("reports liveness, real database readiness, and safe capabilities", async () => {
    const live = await request(runtime.app).get("/api/health/live").set("x-request-id", "runtime-live-1").expect(200);
    expect(live.headers["x-request-id"]).toBe("runtime-live-1");
    expect(live.body).toMatchObject({ status: "ok", live: true, shuttingDown: false, demoProviderEnabled: false });

    const ready = await request(runtime.app).get("/api/health/ready").expect(200);
    expect(ready.body).toMatchObject({ status: "ready", ready: true, database: "pglite" });
    const legacy = await request(runtime.app).get("/api/health").expect(200);
    expect(legacy.body).toMatchObject({ status: "ok", ready: true, database: "pglite" });

    const capabilities = await request(runtime.app).get("/api/v1/capabilities").expect(200);
    expect(capabilities.body).toEqual({
      demoProviderEnabled: false,
      officialOnly: true,
      providers: { demo: false, baileys: false, meta: true }
    });
  });

  it("enforces the official-channel boundary in routes and provider dispatch", async () => {
    const account = await request(runtime.app)
      .post("/api/v1/accounts")
      .send({ name: "Blocked Baileys", provider: "baileys", riskAccepted: true })
      .expect(403);
    expect(account.body).toMatchObject({ code: "UNOFFICIAL_PROVIDER_DISABLED" });

    const preference = await request(runtime.app)
      .put("/api/v1/integration/preference")
      .send({ strategy: "free_first", defaultProvider: "baileys" })
      .expect(403);
    expect(preference.body).toMatchObject({ code: "UNOFFICIAL_PROVIDER_DISABLED" });

    const residual = await runtime.repository.createAccount({ name: "Residual Baileys", provider: "baileys" });
    const connect = await request(runtime.app).post(`/api/v1/accounts/${residual.id}/connect`).expect(403);
    expect(connect.body).toMatchObject({ code: "UNOFFICIAL_PROVIDER_DISABLED" });
    await request(runtime.app).delete(`/api/v1/accounts/${residual.id}`).expect(204);
  });

  it("rejects Demo account creation and does not mount the Demo inbound route", async () => {
    const account = await request(runtime.app)
      .post("/api/v1/accounts")
      .send({ name: "Disabled Demo", provider: "demo" })
      .expect(403);
    expect(account.body).toMatchObject({ code: "DEMO_PROVIDER_DISABLED" });

    const inbound = await request(runtime.app).post("/api/v1/demo/inbound").send({}).expect(404);
    expect(inbound.body).toMatchObject({ code: "ROUTE_NOT_FOUND" });
  });

  it("keeps residual Demo accounts disabled at the Provider boundary", async () => {
    const residual = await runtime.repository.createAccount({
      name: "Residual disabled Demo",
      provider: "demo"
    });

    const connect = await request(runtime.app).post(`/api/v1/accounts/${residual.id}/connect`).expect(403);
    expect(connect.body).toMatchObject({ code: "DEMO_PROVIDER_DISABLED" });
    const sync = await request(runtime.app).post(`/api/v1/accounts/${residual.id}/sync/contacts`).expect(403);
    expect(sync.body).toMatchObject({ code: "DEMO_PROVIDER_DISABLED" });
    const contact = await request(runtime.app)
      .post("/api/v1/contacts")
      .send({ accountId: residual.id, displayName: "Blocked contact", phone: "+12025550123" })
      .expect(403);
    expect(contact.body).toMatchObject({ code: "DEMO_PROVIDER_DISABLED" });

    await request(runtime.app).delete(`/api/v1/accounts/${residual.id}`).expect(204);
  });

  it("requires an AI Provider for automatic translation and selects the first configured Provider", async () => {
    const rejected = await request(runtime.app)
      .put("/api/v1/translation/preferences")
      .send({ autoTranslate: true })
      .expect(409);
    expect(rejected.body).toMatchObject({ code: "AI_PROVIDER_REQUIRED" });

    const profile = await request(runtime.app)
      .post("/api/v1/ai/providers")
      .send({
        name: "Production-compatible test profile",
        baseUrl: "https://ai.example.test/v1",
        apiKey: "test-key-not-used",
        model: "translation-model"
      })
      .expect(201);
    const preference = await request(runtime.app).get("/api/v1/translation/preferences").expect(200);
    expect(preference.body).toMatchObject({ autoTranslate: false, providerId: profile.body.id });

    await request(runtime.app).put("/api/v1/translation/preferences").send({ autoTranslate: true }).expect(200);
    const cannotClear = await request(runtime.app)
      .put("/api/v1/translation/preferences")
      .send({ providerId: null })
      .expect(409);
    expect(cannotClear.body).toMatchObject({ code: "AI_PROVIDER_REQUIRED" });

    await request(runtime.app).delete(`/api/v1/ai/providers/${profile.body.id}`).expect(204);
    const providers = await request(runtime.app).get("/api/v1/ai/providers").expect(200);
    expect(providers.body).toEqual([]);
    const preferenceAfterDelete = await request(runtime.app).get("/api/v1/translation/preferences").expect(200);
    expect(preferenceAfterDelete.body).toMatchObject({ autoTranslate: false, providerId: null });
    const archived = await runtime.database.query<{
      enabled: number;
      api_key_cipher: string | null;
      api_key_mask: string | null;
    }>("SELECT enabled,api_key_cipher,api_key_mask FROM ai_provider_profiles WHERE id=$1", [profile.body.id]);
    expect(archived.rows[0]).toMatchObject({ enabled: 0, api_key_cipher: null, api_key_mask: null });
    await request(runtime.app)
      .delete(`/api/v1/ai/providers/${profile.body.id}`)
      .expect(404)
      .expect(({ body }) => expect(body).toMatchObject({ code: "AI_PROVIDER_NOT_FOUND" }));
  });

  it("marks readiness unavailable before an idempotent, awaited HTTP shutdown", async () => {
    await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
    const firstClose = runtime.close();
    const secondClose = runtime.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;
    expect(runtime.server.listening).toBe(false);

    const ready = await request(runtime.app).get("/api/health/ready").expect(503);
    expect(ready.body).toMatchObject({ status: "not_ready", ready: false, reason: "shutting_down" });
    const failed = await request(runtime.app).get("/api/v1/translation/preferences").expect(500);
    expect(failed.body).toMatchObject({ error: "Internal server error", code: "INTERNAL_ERROR" });
    expect(failed.body.error).not.toMatch(/closed|database|PGlite/iu);
    expect(failed.headers["x-request-id"]).toBe(failed.body.requestId);
  });
});

import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppRuntime, type AppRuntime } from "../src/server/app";

const secret = "ownership-test-secret-at-least-32-characters";

function token(userId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ sub: userId, ver: 1, iss: "goodjob-crm", aud: "goodjob-crm-web", exp: Math.floor(Date.now() / 1000) + 3600 });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("personal WhatsApp ownership", () => {
  let runtime: AppRuntime;
  const alice = { authorization: `Bearer ${token("user-alice")}` };
  const bob = { authorization: `Bearer ${token("user-bob")}` };
  let accountId = "";

  beforeAll(async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wa-owner-test-"));
    runtime = await createAppRuntime({
      nodeEnv: "test",
      port: 0,
      webOrigin: "http://localhost:5173",
      databaseClient: "pglite",
      pglitePath: path.join(directory, "pgdata"),
      sessionMasterKey: randomBytes(32).toString("base64"),
      seedDemo: false,
      allowPrivateAiEndpoints: false,
      crmJwtSecret: secret
    });
    const created = await request(runtime.app)
      .post("/api/v1/accounts")
      .set(alice)
      .send({ name: "Alice WhatsApp", provider: "baileys", riskAccepted: true })
      .expect(201);
    accountId = created.body.id;
  });

  afterAll(async () => runtime.close());

  it("does not list or access another user's account", async () => {
    await request(runtime.app).get("/api/v1/accounts").set(bob).expect(200).expect([]);
    await request(runtime.app).get(`/api/v1/accounts/${accountId}/meta`).set(bob).expect(404);
    await request(runtime.app).post(`/api/v1/accounts/${accountId}/connect`).set(bob).send({}).expect(404);
  });

  it("rejects missing and forged session identities", async () => {
    await request(runtime.app).get("/api/v1/accounts").expect(401);
    await request(runtime.app).get("/api/v1/accounts").set({ authorization: `Bearer ${token("user-bob")}x` }).expect(401);
  });
});

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ChannelAccount,
  ChatMessage,
  Contact,
  Conversation,
  MetaAccountConfiguration,
  MetaAppConfig
} from "../src/shared/types";
import { createAppRuntime, type AppRuntime } from "../src/server/app";
import { inMemoryDatabasePaths } from "./helpers/test-database";

const appSecret = "meta-app-secret-for-tests";
const verifyToken = "meta-verify-token-for-tests";
const accessToken = "meta-system-user-access-token-for-tests";
const appId = "1234567890";
const wabaId = "998877665544";
const phoneNumberId = "112233445566";
const mismatchPhoneNumberId = "665544332211";

async function readBody(requestMessage: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of requestMessage) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe("Meta Cloud API integration", () => {
  let graphServer: Server;
  let graphBaseUrl: string;
  let runtime: AppRuntime;
  let metaApp: MetaAppConfig;
  let metaAccount: ChannelAccount;
  let sendCount = 0;
  let sendDelayMs = 0;
  let sendResponseStatus = 200;
  const sentBodies: Array<Record<string, unknown>> = [];
  let mediaUploadCount = 0;
  let mediaUploadStatus = 200;
  let lastMediaId = "";
  const uploadedMediaForms: string[] = [];

  const graphHandler = async (incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> => {
    outgoing.setHeader("content-type", "application/json");
    if (incoming.headers.authorization !== `Bearer ${accessToken}`) {
      outgoing.statusCode = 401;
      outgoing.end(JSON.stringify({ error: { message: "Unauthorized" } }));
      return;
    }
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
    if (incoming.method === "GET" && url.pathname === `/v99.0/${wabaId}/phone_numbers`) {
      outgoing.end(JSON.stringify({ data: [{ id: phoneNumberId }] }));
      return;
    }
    if (incoming.method === "GET" && [phoneNumberId, mismatchPhoneNumberId].some((id) => url.pathname === `/v99.0/${id}`)) {
      const id = url.pathname.split("/").at(-1);
      outgoing.end(
        JSON.stringify({
          id,
          display_phone_number: id === phoneNumberId ? "+1 555 123 4567" : "+1 555 765 4321",
          verified_name: "CRM Meta Test",
          quality_rating: "GREEN"
        })
      );
      return;
    }
    if (incoming.method === "POST" && url.pathname === `/v99.0/${phoneNumberId}/media`) {
      mediaUploadCount += 1;
      // multipart/form-data 直接按 utf8 读出来足够核对字段名与文件名。
      uploadedMediaForms.push(await readBody(incoming));
      if (mediaUploadStatus !== 200) {
        outgoing.statusCode = mediaUploadStatus;
        outgoing.end(JSON.stringify({ error: { message: "Mock media failure" } }));
        return;
      }
      lastMediaId = `media-${mediaUploadCount}`;
      outgoing.end(JSON.stringify({ id: lastMediaId }));
      return;
    }
    if (incoming.method === "POST" && url.pathname === `/v99.0/${phoneNumberId}/messages`) {
      sendCount += 1;
      sentBodies.push(JSON.parse(await readBody(incoming)) as Record<string, unknown>);
      if (sendDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, sendDelayMs));
      if (sendResponseStatus !== 200) {
        outgoing.statusCode = sendResponseStatus;
        outgoing.end(JSON.stringify({ error: { message: "Mock send failure" } }));
        return;
      }
      outgoing.end(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.out.${sendCount}` }] }));
      return;
    }
    outgoing.statusCode = 404;
    outgoing.end(JSON.stringify({ error: { message: "Not found" } }));
  };

  const signedWebhook = async (payload: object, signatureSecret = appSecret) => {
    const rawBody = JSON.stringify(payload);
    const signature = createHmac("sha256", signatureSecret).update(rawBody).digest("hex");
    return request(runtime.app)
      .post(metaApp.webhookPath)
      .set("content-type", "application/json")
      .set("x-hub-signature-256", `sha256=${signature}`)
      .send(rawBody);
  };

  const inboundPayload = (input: { from: string; messageId: string; body: string }) => ({
    object: "whatsapp_business_account",
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: phoneNumberId, display_phone_number: "15551234567" },
              contacts: [{ wa_id: input.from, profile: { name: "Meta Lead" } }],
              messages: [
                {
                  from: input.from,
                  id: input.messageId,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: input.body }
                }
              ]
            }
          }
        ]
      }
    ]
  });

  beforeAll(async () => {
    graphServer = createServer((incoming, outgoing) => void graphHandler(incoming, outgoing));
    await new Promise<void>((resolve) => graphServer.listen(0, "127.0.0.1", resolve));
    const address = graphServer.address();
    if (!address || typeof address === "string") throw new Error("Graph mock did not bind to a TCP port");
    graphBaseUrl = `http://127.0.0.1:${address.port}`;

    const directory = await mkdtemp(path.join(os.tmpdir(), "wa-crm-meta-test-"));
    runtime = await createAppRuntime({
      nodeEnv: "test",
      port: 0,
      webOrigin: "http://localhost:5173",
      databaseClient: "pglite",
      ...inMemoryDatabasePaths(directory),
      sessionMasterKey: randomBytes(32).toString("base64"),
      seedDemo: false,
      allowPrivateAiEndpoints: false,
      metaGraphBaseUrl: graphBaseUrl
    });

    metaApp = (
      await request(runtime.app)
        .post("/api/v1/meta/apps")
        .send({ name: "Meta Test App", appId, appSecret, verifyToken })
        .expect(201)
    ).body as MetaAppConfig;
    metaAccount = (
      await request(runtime.app)
        .post("/api/v1/accounts")
        .send({ name: "Official Sales", provider: "meta", purposeLabel: "Official API" })
        .expect(201)
    ).body as ChannelAccount;
    await request(runtime.app)
      .put(`/api/v1/accounts/${metaAccount.id}/meta`)
      .send({ appConfigId: metaApp.id, wabaId, phoneNumberId, accessToken, graphApiVersion: "v99.0" })
      .expect(200);
  }, 30_000);

  afterAll(async () => {
    await runtime.close();
    await new Promise<void>((resolve, reject) => graphServer.close((error) => (error ? reject(error) : resolve())));
  });

  it("persists integration strategy and never exposes Meta secrets", async () => {
    const preference = await request(runtime.app)
      .put("/api/v1/integration/preference")
      .send({ strategy: "hybrid", defaultProvider: "meta" })
      .expect(200);
    expect(preference.body).toMatchObject({ strategy: "hybrid", defaultProvider: "meta", updatedAt: expect.any(String) });
    await request(runtime.app)
      .get("/api/v1/integration/preference")
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ strategy: "hybrid", defaultProvider: "meta" }));

    const apps = await request(runtime.app).get("/api/v1/meta/apps").expect(200);
    const configurations = await request(runtime.app).get("/api/v1/meta/configurations").expect(200);
    const publicPayload = JSON.stringify({ apps: apps.body, configurations: configurations.body });
    expect(publicPayload).not.toContain(appSecret);
    expect(publicPayload).not.toContain(verifyToken);
    expect(publicPayload).not.toContain(accessToken);
    expect(apps.body[0]).toMatchObject({ appSecretMask: "****ests", verifyTokenMask: "****ests" });
    expect(configurations.body[0]).toMatchObject({ accessTokenMask: "****ests", accountId: metaAccount.id });

    const stored = await runtime.database.query<{
      app_secret_cipher: string;
      verify_token_digest: string;
      access_token_cipher: string;
    }>(
      `SELECT a.app_secret_cipher,a.verify_token_digest,c.access_token_cipher
       FROM meta_app_configs a JOIN meta_account_credentials c ON c.app_config_id=a.id WHERE c.account_id=$1`,
      [metaAccount.id]
    );
    expect(stored.rows[0].app_secret_cipher).not.toContain(appSecret);
    expect(stored.rows[0].verify_token_digest).not.toContain(verifyToken);
    expect(stored.rows[0].access_token_cipher).not.toContain(accessToken);
  });

  it("validates the phone number and its WABA ownership before connecting", async () => {
    const connected = await request(runtime.app).post(`/api/v1/accounts/${metaAccount.id}/connect`).expect(202);
    expect(connected.body).toMatchObject({ status: "connected", phone: "+15551234567" });
    const configuration = (
      await request(runtime.app).get(`/api/v1/accounts/${metaAccount.id}/meta`).expect(200)
    ).body as MetaAccountConfiguration;
    expect(configuration).toMatchObject({
      displayPhoneNumber: "+1 555 123 4567",
      verifiedName: "CRM Meta Test",
      qualityRating: "GREEN",
      lastVerifiedAt: expect.any(String)
    });

    const mismatched = (
      await request(runtime.app).post("/api/v1/accounts").send({ name: "Wrong WABA", provider: "meta" }).expect(201)
    ).body as ChannelAccount;
    await request(runtime.app)
      .put(`/api/v1/accounts/${mismatched.id}/meta`)
      .send({ appConfigId: metaApp.id, wabaId, phoneNumberId: mismatchPhoneNumberId, accessToken, graphApiVersion: "v99.0" })
      .expect(200);
    const rejected = await request(runtime.app).post(`/api/v1/accounts/${mismatched.id}/connect`).expect(422);
    expect(rejected.body).toMatchObject({ code: "META_WABA_MISMATCH" });
    const accounts = (await request(runtime.app).get("/api/v1/accounts").expect(200)).body as ChannelAccount[];
    expect(accounts.find((account) => account.id === mismatched.id)?.status).toBe("credential_invalid");
  });

  it("accepts inbound webhooks while the process connection cache is cold", async () => {
    runtime.providers.meta.shutdown();
    const persistedState = await runtime.database.query<{ status: string; sending_enabled: number }>(
      `SELECT a.status,c.sending_enabled
       FROM channel_accounts a JOIN meta_account_credentials c ON c.account_id=a.id
       WHERE a.id=$1`,
      [metaAccount.id]
    );
    expect(persistedState.rows[0]).toMatchObject({ status: "connected", sending_enabled: 1 });

    const payload = inboundPayload({
      from: "15550004444",
      messageId: "wamid.in.cold-process-cache",
      body: "Can you share the product catalog?"
    });
    await signedWebhook(payload).then((response) => expect(response.status).toBe(200));

    const contacts = (await request(runtime.app).get(`/api/v1/contacts?accountId=${metaAccount.id}`).expect(200)).body as Contact[];
    expect(contacts.find((contact) => contact.phone === "+15550004444")).toMatchObject({
      source: "meta",
      origin: "inbound_message"
    });
    expect(await runtime.repository.findMessageByIdempotency(metaAccount.id, "wamid.in.cold-process-cache")).toMatchObject({
      direction: "inbound",
      status: "delivered"
    });
  });

  it("verifies raw webhook signatures and stores duplicate inbound text only once", async () => {
    await request(runtime.app)
      .get(metaApp.webhookPath)
      .query({ "hub.mode": "subscribe", "hub.verify_token": verifyToken, "hub.challenge": "meta-challenge" })
      .expect(200, "meta-challenge");
    await request(runtime.app)
      .get(metaApp.webhookPath)
      .query({ "hub.mode": "subscribe", "hub.verify_token": "wrong-token", "hub.challenge": "meta-challenge" })
      .expect(403);

    const payload = inboundPayload({ from: "15550001111", messageId: "wamid.in.1", body: "Can you send a quote?" });
    const inboxBefore = await runtime.database.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM meta_webhook_events WHERE app_config_id=$1",
      [metaApp.id]
    );
    await signedWebhook(payload, "wrong-signing-secret").then((response) => expect(response.status).toBe(401));
    const inboxAfterInvalidSignature = await runtime.database.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM meta_webhook_events WHERE app_config_id=$1",
      [metaApp.id]
    );
    expect(Number(inboxAfterInvalidSignature.rows[0].count)).toBe(Number(inboxBefore.rows[0].count));
    const duplicateResponses = await Promise.all([signedWebhook(payload), signedWebhook(payload)]);
    expect(duplicateResponses.map((response) => response.status)).toEqual([200, 200]);

    const inbox = await runtime.database.query<{ status: string; attempts: number | string }>(
      `SELECT status,attempts FROM meta_webhook_events
       WHERE app_config_id=$1 AND event_hash=$2`,
      [metaApp.id, createHash("sha256").update(JSON.stringify(payload)).digest("hex")]
    );
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0]).toMatchObject({ status: "processed" });
    expect(Number(inbox.rows[0].attempts)).toBe(1);

    const contacts = (await request(runtime.app).get(`/api/v1/contacts?accountId=${metaAccount.id}`).expect(200)).body as Contact[];
    expect(contacts.filter((contact) => contact.phone === "+15550001111")).toHaveLength(1);
    expect(contacts.find((contact) => contact.phone === "+15550001111")).toMatchObject({
      providerContactId: "15550001111",
      source: "meta",
      origin: "inbound_message"
    });
    const conversations = (
      await request(runtime.app).get(`/api/v1/conversations?accountId=${metaAccount.id}`).expect(200)
    ).body as Conversation[];
    const conversation = conversations.find((item) => item.contactPhone === "+15550001111")!;
    const messages = (
      await request(runtime.app).get(`/api/v1/conversations/${conversation.id}/messages`).expect(200)
    ).body as ChatMessage[];
    expect(messages.filter((message) => message.providerMessageId === "wamid.in.1")).toHaveLength(1);
  });

  it("recovers a persisted Meta webhook event without duplicating its message", async () => {
    const payload = inboundPayload({
      from: "15550005555",
      messageId: "wamid.in.recovery",
      body: "Please remind me about the revised quote"
    });
    await signedWebhook(payload).then((response) => expect(response.status).toBe(200));
    const eventHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const event = await runtime.database.query<{ id: string; attempts: number | string }>(
      "SELECT id,attempts FROM meta_webhook_events WHERE app_config_id=$1 AND event_hash=$2",
      [metaApp.id, eventHash]
    );
    expect(event.rows).toHaveLength(1);
    await runtime.database.query(
      `UPDATE meta_webhook_events
       SET status='pending',processing_started_at=NULL,processed_at=NULL,updated_at=$2 WHERE id=$1`,
      [event.rows[0].id, new Date().toISOString()]
    );

    expect(await runtime.providers.meta.recoverPendingWebhookEvents()).toEqual({ processed: 1, failed: 0 });
    const recovered = await runtime.database.query<{ status: string; attempts: number | string; processed_at: string | null }>(
      "SELECT status,attempts,processed_at FROM meta_webhook_events WHERE id=$1",
      [event.rows[0].id]
    );
    expect(recovered.rows[0].status).toBe("processed");
    expect(Number(recovered.rows[0].attempts)).toBe(Number(event.rows[0].attempts) + 1);
    expect(recovered.rows[0].processed_at).not.toBeNull();

    const stored = await runtime.database.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM messages WHERE account_id=$1 AND provider_message_id=$2",
      [metaAccount.id, "wamid.in.recovery"]
    );
    expect(Number(stored.rows[0].count)).toBe(1);
  });

  it("extracts evidence-backed customer traits and creates actionable follow-ups", async () => {
    const payload = inboundPayload({
      from: "15550006666",
      messageId: "wamid.in.intelligence",
      body: "We need 500 units. Please send your price and lead time."
    });
    await signedWebhook(payload).then((response) => expect(response.status).toBe(200));
    const conversations = (await request(runtime.app).get(`/api/v1/conversations?accountId=${metaAccount.id}`).expect(200)).body as Conversation[];
    const conversation = conversations.find((item) => item.contactPhone === "+15550006666");
    expect(conversation).toBeDefined();

    const generated = await request(runtime.app)
      .post(`/api/v1/conversations/${conversation!.id}/intelligence/analyze`)
      .expect(200);
    expect(generated.body.analysis).toMatchObject({ buyingIntent: "high", riskLevel: "medium" });
    expect(generated.body.analysis.traits).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "quote", evidenceMessageIds: [expect.any(String)] }),
      expect.objectContaining({ key: "quantity" })
    ]));
    expect(generated.body.followups).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "准备并发送报价", status: "pending" })
    ]));

    const quoteFollowup = generated.body.followups.find((item: { sourceKey: string }) => item.sourceKey.startsWith("quote:"));
    expect(quoteFollowup).toBeDefined();

    const rejected = await request(runtime.app)
      .put(`/api/v1/conversations/${conversation!.id}/intelligence/feedback`)
      .send({ traitKey: "quote", traitLabel: "价格敏感", verdict: "rejected" })
      .expect(200);
    expect(rejected.body.analysis.traits).not.toEqual(expect.arrayContaining([expect.objectContaining({ key: "quote" })]));
    expect(rejected.body.feedback).toEqual(expect.arrayContaining([expect.objectContaining({ traitKey: "quote", verdict: "rejected" })]));
    expect(rejected.body.followups.find((item: { id: string }) => item.id === quoteFollowup.id).status).toBe("dismissed");

    const restored = await request(runtime.app)
      .delete(`/api/v1/conversations/${conversation!.id}/intelligence/feedback/quote`)
      .expect(200);
    expect(restored.body.analysis.traits).toEqual(expect.arrayContaining([expect.objectContaining({ key: "quote" })]));
    expect(restored.body.feedback).not.toEqual(expect.arrayContaining([expect.objectContaining({ traitKey: "quote" })]));
    expect(restored.body.followups.find((item: { id: string }) => item.id === quoteFollowup.id).status).toBe("pending");

    const followupId = quoteFollowup.id as string;
    await request(runtime.app).patch(`/api/v1/followups/${followupId}`).send({ status: "completed" }).expect(200);
    const current = await request(runtime.app).get(`/api/v1/conversations/${conversation!.id}/intelligence`).expect(200);
    expect(current.body.followups.find((item: { id: string }) => item.id === followupId).status).toBe("completed");
  });

  it("archives non-text Meta message types instead of silently dropping them", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ id: wabaId, changes: [{ field: "messages", value: {
        metadata: { phone_number_id: phoneNumberId },
        contacts: [{ wa_id: "15550007777", profile: { name: "Media Buyer" } }],
        messages: [
          { from: "15550007777", id: "wamid.image.1", type: "image", image: { id: "media-1", caption: "报价参考图" } },
          { from: "15550007777", id: "wamid.location.1", type: "location", location: { latitude: 31.23, longitude: 121.47, name: "Shanghai" } }
        ]
      } }] }]
    };
    await signedWebhook(payload).then((response) => expect(response.status).toBe(200));
    const conversations = (await request(runtime.app).get(`/api/v1/conversations?accountId=${metaAccount.id}`).expect(200)).body as Conversation[];
    const conversation = conversations.find((item) => item.contactPhone === "+15550007777")!;
    const messages = (await request(runtime.app).get(`/api/v1/conversations/${conversation.id}/messages`).expect(200)).body as ChatMessage[];
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerMessageId: "wamid.image.1", messageType: "image", body: "报价参考图" }),
      expect.objectContaining({ providerMessageId: "wamid.location.1", messageType: "system", body: expect.stringContaining("Shanghai") })
    ]));
  });

  it("enforces the 24-hour gate and deduplicates concurrent client message IDs", async () => {
    const manual = await request(runtime.app)
      .post("/api/v1/contacts")
      .send({ accountId: metaAccount.id, displayName: "Cold Lead", phone: "+15550002222" })
      .expect(201);
    const blocked = await request(runtime.app)
      .post(`/api/v1/conversations/${manual.body.conversation.id}/messages`)
      .send({ accountId: metaAccount.id, clientMessageId: randomUUID(), body: "Cold free-form message" })
      .expect(409);
    expect(blocked.body).toMatchObject({ code: "TEMPLATE_REQUIRED" });

    const template = await request(runtime.app)
      .post(`/api/v1/conversations/${manual.body.conversation.id}/template-messages`)
      .send({
        accountId: metaAccount.id,
        clientMessageId: randomUUID(),
        templateName: "catalog_follow_up",
        languageCode: "en_US",
        bodyParameters: ["Cold Lead", "2026-07-20"]
      })
      .expect(201);
    expect(template.body).toMatchObject({ status: "accepted", body: expect.stringContaining("catalog_follow_up") });
    expect(sentBodies.at(-1)).toMatchObject({
      messaging_product: "whatsapp",
      to: "15550002222",
      type: "template",
      template: {
        name: "catalog_follow_up",
        language: { code: "en_US" },
        components: [{
          type: "body",
          parameters: [{ type: "text", text: "Cold Lead" }, { type: "text", text: "2026-07-20" }]
        }]
      }
    });

    const conversations = (
      await request(runtime.app).get(`/api/v1/conversations?accountId=${metaAccount.id}`).expect(200)
    ).body as Conversation[];
    const conversation = conversations.find((item) => item.contactPhone === "+15550001111")!;
    const clientMessageId = randomUUID();
    const before = sendCount;
    sendDelayMs = 80;
    const [first, second] = await Promise.all([
      request(runtime.app)
        .post(`/api/v1/conversations/${conversation.id}/messages`)
        .send({ accountId: metaAccount.id, clientMessageId, body: "Here is the quotation." }),
      request(runtime.app)
        .post(`/api/v1/conversations/${conversation.id}/messages`)
        .send({ accountId: metaAccount.id, clientMessageId, body: "Here is the quotation." })
    ]);
    sendDelayMs = 0;
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).toBe(second.body.id);
    expect(sendCount - before).toBe(1);
    expect(sentBodies.at(-1)).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "15550001111",
      type: "text",
      text: { preview_url: false, body: "Here is the quotation." }
    });
  });

  it("uploads images and documents before sending them on the official channel", async () => {
    const conversations = (
      await request(runtime.app).get(`/api/v1/conversations?accountId=${metaAccount.id}`).expect(200)
    ).body as Conversation[];
    const conversation = conversations.find((item) => item.contactPhone === "+15550001111")!;

    const imageId = randomUUID();
    const image = await request(runtime.app)
      .post(
        `/api/v1/conversations/${conversation.id}/media?accountId=${metaAccount.id}&clientMessageId=${imageId}` +
          "&kind=image&fileName=pricing-table.png&mimeType=image/png&caption=Here is the price list"
      )
      .set("content-type", "application/octet-stream")
      .send(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]))
      .expect(201);
    expect(image.body).toMatchObject({
      direction: "outbound",
      messageType: "image",
      status: "accepted",
      body: "Here is the price list",
      providerMessageId: expect.any(String)
    });
    // 第一步：媒体上传（multipart）拿到 media id；第二步：用它发 image 消息。
    expect(uploadedMediaForms.at(-1)).toContain('name="messaging_product"');
    expect(uploadedMediaForms.at(-1)).toContain('name="file"; filename="pricing-table.png"');
    expect(sentBodies.at(-1)).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "15550001111",
      type: "image",
      image: { id: lastMediaId, caption: "Here is the price list" }
    });

    const fileId = randomUUID();
    const file = await request(runtime.app)
      .post(
        `/api/v1/conversations/${conversation.id}/media?accountId=${metaAccount.id}&clientMessageId=${fileId}` +
          "&kind=file&fileName=quotation.pdf&mimeType=application/pdf&caption=Please review"
      )
      .set("content-type", "application/octet-stream")
      .send(Buffer.from("%PDF-1.7 official channel mock"))
      .expect(201);
    expect(file.body).toMatchObject({ messageType: "file", status: "accepted", body: "Please review" });
    // 文件必须以 document 类型发送，并带上原始文件名。
    expect(sentBodies.at(-1)).toMatchObject({
      to: "15550001111",
      type: "document",
      document: { id: lastMediaId, caption: "Please review", filename: "quotation.pdf" }
    });

    const persisted = (
      await request(runtime.app).get(`/api/v1/conversations/${conversation.id}/messages`).expect(200)
    ).body as ChatMessage[];
    expect(persisted.find((message) => message.clientMessageId === fileId)).toMatchObject({
      messageType: "file",
      clientMessageId: fileId
    });
  });

  it("never uploads media outside the 24-hour window and converges a rejected upload", async () => {
    const cold = await request(runtime.app)
      .post("/api/v1/contacts")
      .send({ accountId: metaAccount.id, displayName: "Cold Media Lead", phone: "+15550008888" })
      .expect(201);
    const beforeUploads = mediaUploadCount;
    const blocked = await request(runtime.app)
      .post(
        `/api/v1/conversations/${cold.body.conversation.id}/media?accountId=${metaAccount.id}&clientMessageId=${randomUUID()}` +
          "&kind=image&fileName=cold.png&mimeType=image/png"
      )
      .set("content-type", "application/octet-stream")
      .send(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      .expect(409);
    expect(blocked.body).toMatchObject({ code: "TEMPLATE_REQUIRED" });
    // 窗口外必须直接拒绝，不能先上传再失败，否则会留下孤儿媒体。
    expect(mediaUploadCount).toBe(beforeUploads);

    const conversations = (
      await request(runtime.app).get(`/api/v1/conversations?accountId=${metaAccount.id}`).expect(200)
    ).body as Conversation[];
    const conversation = conversations.find((item) => item.contactPhone === "+15550001111")!;
    const rejectedId = randomUUID();
    mediaUploadStatus = 422;
    const rejected = await request(runtime.app)
      .post(
        `/api/v1/conversations/${conversation.id}/media?accountId=${metaAccount.id}&clientMessageId=${rejectedId}` +
          "&kind=image&fileName=broken.png&mimeType=image/png"
      )
      .set("content-type", "application/octet-stream")
      .send(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      .expect(422);
    mediaUploadStatus = 200;
    expect(rejected.body).toMatchObject({ code: "META_MEDIA_REJECTED" });
    // 上传被拒后消息不能停在 sending。
    expect((await runtime.repository.findMessageByIdempotency(metaAccount.id, undefined, rejectedId))?.status).toBe("failed");

    const uncertainId = randomUUID();
    mediaUploadStatus = 503;
    const uncertain = await request(runtime.app)
      .post(
        `/api/v1/conversations/${conversation.id}/media?accountId=${metaAccount.id}&clientMessageId=${uncertainId}` +
          "&kind=image&fileName=flaky.png&mimeType=image/png"
      )
      .set("content-type", "application/octet-stream")
      .send(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      .expect(502);
    mediaUploadStatus = 200;
    expect(uncertain.body).toMatchObject({ code: "META_GRAPH_UNAVAILABLE" });
    expect((await runtime.repository.findMessageByIdempotency(metaAccount.id, undefined, uncertainId))?.status).toBe("unknown");
  });

  it("keeps message status monotonic and reports the standard contact-sync boundary", async () => {
    const conversations = (
      await request(runtime.app).get(`/api/v1/conversations?accountId=${metaAccount.id}`).expect(200)
    ).body as Conversation[];
    const conversation = conversations.find((item) => item.contactPhone === "+15550001111")!;
    const messages = (
      await request(runtime.app).get(`/api/v1/conversations/${conversation.id}/messages`).expect(200)
    ).body as ChatMessage[];
    const outbound = messages.find((message) => message.direction === "outbound")!;
    const statusPayload = (status: string, timestamp: number) => ({
      object: "whatsapp_business_account",
      entry: [
        {
          id: wabaId,
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: phoneNumberId },
                statuses: [{ id: outbound.providerMessageId, status, timestamp: String(timestamp) }]
              }
            }
          ]
        }
      ]
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    await signedWebhook(statusPayload("read", nowSeconds)).then((response) => expect(response.status).toBe(200));
    await signedWebhook(statusPayload("delivered", nowSeconds - 10)).then((response) => expect(response.status).toBe(200));
    await signedWebhook(statusPayload("failed", nowSeconds - 20)).then((response) => expect(response.status).toBe(200));
    const after = (
      await request(runtime.app).get(`/api/v1/conversations/${conversation.id}/messages`).expect(200)
    ).body as ChatMessage[];
    expect(after.find((message) => message.id === outbound.id)?.status).toBe("read");

    const sync = await request(runtime.app).post(`/api/v1/accounts/${metaAccount.id}/sync/contacts`).expect(202);
    expect(sync.body).toMatchObject({ count: expect.any(Number), note: expect.stringContaining("does not expose a full address book") });
  });

  it("stores deterministic Graph rejection as failed and uncertain failure as unknown", async () => {
    const conversations = (
      await request(runtime.app).get(`/api/v1/conversations?accountId=${metaAccount.id}`).expect(200)
    ).body as Conversation[];
    const conversation = conversations.find((item) => item.contactPhone === "+15550001111")!;

    const rejectedId = randomUUID();
    sendResponseStatus = 400;
    const rejected = await request(runtime.app)
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .send({ accountId: metaAccount.id, clientMessageId: rejectedId, body: "Rejected message" })
      .expect(422);
    expect(rejected.body).toMatchObject({ code: "META_SEND_REJECTED" });
    expect((await runtime.repository.findMessageByIdempotency(metaAccount.id, undefined, rejectedId))?.status).toBe("failed");

    const uncertainId = randomUUID();
    sendResponseStatus = 503;
    const uncertain = await request(runtime.app)
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .send({ accountId: metaAccount.id, clientMessageId: uncertainId, body: "Uncertain message" })
      .expect(502);
    expect(uncertain.body).toMatchObject({ code: "META_SEND_UNCERTAIN" });
    expect((await runtime.repository.findMessageByIdempotency(metaAccount.id, undefined, uncertainId))?.status).toBe("unknown");
    sendResponseStatus = 200;
  });

  it("blocks the same phone from being active on a second non-coexistence channel", async () => {
    const competing = (
      await request(runtime.app)
        .post("/api/v1/accounts")
        .send({
          name: "Competing free channel",
          provider: "baileys",
          phone: "+15551234567",
          riskAccepted: true
        })
        .expect(201)
    ).body as ChannelAccount;
    await runtime.repository.updateAccountStatus(competing.id, "connected", { phone: "+15551234567" });

    const blocked = await request(runtime.app).post(`/api/v1/accounts/${metaAccount.id}/connect`).expect(409);
    expect(blocked.body).toMatchObject({ code: "PHONE_ACTIVE_ON_OTHER_ACCOUNT" });
    await request(runtime.app).delete(`/api/v1/accounts/${competing.id}`).expect(204);
    await request(runtime.app).post(`/api/v1/accounts/${metaAccount.id}/connect`).expect(202);
  });

  it("pauses new inbound work locally without deleting the encrypted Meta token", async () => {
    const before = await runtime.database.query<{ access_token_cipher: string }>(
      "SELECT access_token_cipher FROM meta_account_credentials WHERE account_id=$1",
      [metaAccount.id]
    );
    const disabled = await request(runtime.app).post(`/api/v1/accounts/${metaAccount.id}/logout`).expect(200);
    expect(disabled.body.status).toBe("logged_out");
    const after = await runtime.database.query<{ access_token_cipher: string }>(
      "SELECT access_token_cipher FROM meta_account_credentials WHERE account_id=$1",
      [metaAccount.id]
    );
    expect(after.rows[0].access_token_cipher).toBe(before.rows[0].access_token_cipher);
    await request(runtime.app).get(`/api/v1/accounts/${metaAccount.id}/meta`).expect(200);

    const pausedInbound = inboundPayload({
      from: "15550003333",
      messageId: "wamid.in.paused",
      body: "This message must not create CRM or AI work while paused"
    });
    await signedWebhook(pausedInbound).then((response) => expect(response.status).toBe(200));
    const contacts = (await request(runtime.app).get(`/api/v1/contacts?accountId=${metaAccount.id}`).expect(200)).body as Contact[];
    expect(contacts.some((contact) => contact.phone === "+15550003333")).toBe(false);
    await request(runtime.app)
      .get("/api/health")
      .expect(200)
      .expect(({ body }) => expect(body.activeConnections).toBe(0));
  });
});

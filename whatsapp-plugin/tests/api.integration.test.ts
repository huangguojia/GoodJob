import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChannelAccount, ChatMessage, Contact, Conversation, TranslationPreference } from "../src/shared/types";
import { createAppRuntime, type AppRuntime } from "../src/server/app";
import { createDatabase } from "../src/server/db/database";
import { migrate } from "../src/server/db/migrate";
import { Repository } from "../src/server/db/repository";
import { seed, seedDemo } from "../src/server/db/seed";

describe("WhatsApp CRM Plugin API", () => {
  let runtime: AppRuntime;
  let accounts: ChannelAccount[];

  beforeAll(async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wa-crm-test-"));
    const config = {
      nodeEnv: "test",
      port: 0,
      webOrigin: "http://localhost:5173",
      databaseClient: "pglite",
      pglitePath: path.join(directory, "pgdata"),
      sessionMasterKey: randomBytes(32).toString("base64"),
      seedDemo: true,
      allowPrivateAiEndpoints: false
    } as const;
    const fixtureDatabase = await createDatabase(config);
    await migrate(fixtureDatabase);
    const fixtureRepository = new Repository(fixtureDatabase);
    await seed(fixtureDatabase, fixtureRepository, config);
    await seedDemo(fixtureDatabase, fixtureRepository, config);
    await fixtureDatabase.close();

    runtime = await createAppRuntime(config);
    accounts = (await request(runtime.app).get("/api/v1/accounts").expect(200)).body as ChannelAccount[];
  }, 30_000);

  afterAll(async () => {
    await runtime.close();
  });

  it("starts with two isolated connected demo accounts", async () => {
    expect(accounts).toHaveLength(2);
    expect(accounts.every((account) => account.status === "connected")).toBe(true);
    const health = await request(runtime.app).get("/api/health").expect(200);
    expect(health.body).toMatchObject({ status: "ok", database: "pglite", activeConnections: 2 });
  });

  it("rejects contradictory fixed integration strategies", async () => {
    await request(runtime.app)
      .put("/api/v1/integration/preference")
      .send({ strategy: "free_first", defaultProvider: "meta" })
      .expect(400);
    await request(runtime.app)
      .put("/api/v1/integration/preference")
      .send({ strategy: "official_first", defaultProvider: "baileys" })
      .expect(400);
    await request(runtime.app)
      .put("/api/v1/integration/preference")
      .send({ strategy: "hybrid", defaultProvider: "meta" })
      .expect(200);
  });

  it("validates and persists the local attachment retention policy", async () => {
    const initial = await request(runtime.app).get("/api/v1/media-retention").expect(200);
    expect(initial.body).toMatchObject({ mode: "immediate", days: 0 });

    const retained = await request(runtime.app)
      .put("/api/v1/media-retention")
      .send({ mode: "days", days: 30 })
      .expect(200);
    expect(retained.body).toMatchObject({ mode: "days", days: 30 });

    await request(runtime.app)
      .put("/api/v1/media-retention")
      .send({ mode: "days", days: 0 })
      .expect(400);

    const immediate = await request(runtime.app)
      .put("/api/v1/media-retention")
      .send({ mode: "immediate", days: 0 })
      .expect(200);
    expect(immediate.body).toMatchObject({ mode: "immediate", days: 0 });
  });

  it("blocks unsafe attachment types before provider dispatch", async () => {
    const conversations = (
      await request(runtime.app).get(`/api/v1/conversations?accountId=${accounts[0].id}`).expect(200)
    ).body as Conversation[];

    const response = await request(runtime.app)
      .post(`/api/v1/conversations/${conversations[0].id}/media`)
      .query({
        accountId: accounts[0].id,
        clientMessageId: randomUUID(),
        kind: "file",
        fileName: "installer.exe",
        mimeType: "application/x-msdownload",
        caption: ""
      })
      .set("content-type", "application/octet-stream")
      .send(Buffer.from("blocked"))
      .expect(400);
    expect(response.body).toMatchObject({ code: "MEDIA_TYPE_BLOCKED" });

    await request(runtime.app)
      .post(`/api/v1/conversations/${conversations[0].id}/media`)
      .query({
        accountId: accounts[0].id,
        clientMessageId: randomUUID(),
        kind: "image",
        fileName: "active.svg",
        mimeType: "image/svg+xml",
        caption: ""
      })
      .set("content-type", "image/svg+xml")
      .send(Buffer.from("<svg></svg>"))
      .expect(400);
  });

  it("rejects sending a conversation through another account", async () => {
    const conversations = (
      await request(runtime.app).get(`/api/v1/conversations?accountId=${accounts[0].id}`).expect(200)
    ).body as Conversation[];
    expect(conversations.length).toBeGreaterThan(0);

    await request(runtime.app)
      .post(`/api/v1/conversations/${conversations[0].id}/messages`)
      .send({ accountId: accounts[1].id, clientMessageId: randomUUID(), body: "Wrong account" })
      .expect(409);
  });

  it("does not create automatic translations while disabled and supports one-message manual translation", async () => {
    await request(runtime.app).put("/api/v1/translation/preferences").send({ autoTranslate: false }).expect(200);
    const inbound = await request(runtime.app).post("/api/v1/demo/inbound").send({
      accountId: accounts[0].id,
      displayName: "Manual Translate Lead",
      phone: "+34910000031",
      body: "¿Cuál es la cantidad mínima de pedido?"
    }).expect(201);

    await new Promise((resolve) => setTimeout(resolve, 80));
    const created = inbound.body as ChatMessage;
    const messagesBefore = (
      await request(runtime.app).get(`/api/v1/conversations/${created.conversationId}/messages`).expect(200)
    ).body as ChatMessage[];
    expect(messagesBefore.find((item) => item.id === created.id)?.translations).toHaveLength(0);

    const translation = await request(runtime.app).post(`/api/v1/messages/${created.id}/translations`).expect(201);
    expect(translation.body).toMatchObject({ status: "translated", trigger: "manual", targetLanguage: "zh-CN" });
    expect(translation.body.translatedText).toContain("最小起订量");
  });

  it("automatically translates new non-target-language messages when enabled", async () => {
    const preference = (
      await request(runtime.app).put("/api/v1/translation/preferences").send({ autoTranslate: true }).expect(200)
    ).body as TranslationPreference;
    expect(preference.autoTranslate).toBe(true);

    const inbound = await request(runtime.app).post("/api/v1/demo/inbound").send({
      accountId: accounts[1].id,
      displayName: "Auto Translate Lead",
      phone: "+525500000042",
      body: "Can you send the latest catalog?"
    }).expect(201);
    const created = inbound.body as ChatMessage;

    let translated: ChatMessage | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const messages = (
        await request(runtime.app).get(`/api/v1/conversations/${created.conversationId}/messages`).expect(200)
      ).body as ChatMessage[];
      translated = messages.find((item) => item.id === created.id);
      if (translated?.translations[0]?.status === "translated") break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(translated?.translations[0]).toMatchObject({ status: "translated", trigger: "automatic" });
    expect(translated?.translations[0].translatedText).toContain("最新的产品目录");
  });

  it("also stores a display translation for newly sent non-target-language messages", async () => {
    const conversations = (
      await request(runtime.app).get(`/api/v1/conversations?accountId=${accounts[0].id}`).expect(200)
    ).body as Conversation[];
    const sent = await request(runtime.app)
      .post(`/api/v1/conversations/${conversations[0].id}/messages`)
      .send({
        accountId: accounts[0].id,
        clientMessageId: randomUUID(),
        body: "Can you send the latest catalog?"
      })
      .expect(201);
    const created = sent.body as ChatMessage;

    let translated: ChatMessage | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const messages = (
        await request(runtime.app).get(`/api/v1/conversations/${created.conversationId}/messages`).expect(200)
      ).body as ChatMessage[];
      translated = messages.find((item) => item.id === created.id);
      if (translated?.translations[0]?.status === "translated") break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(translated?.translations[0]).toMatchObject({ status: "translated", trigger: "automatic" });
  });

  it("auto-creates and deduplicates CRM Sandbox contacts by E.164 phone", async () => {
    await request(runtime.app).put("/api/v1/translation/preferences").send({ crmAutoCreate: true }).expect(200);
    const payload = {
      accountId: accounts[0].id,
      displayName: "CRM Auto Lead",
      phone: "+33142000091",
      body: "Bonjour, merci de nous envoyer le prix."
    };
    await request(runtime.app).post("/api/v1/demo/inbound").send(payload).expect(201);
    await request(runtime.app).post("/api/v1/demo/inbound").send(payload).expect(201);

    const contacts = (await request(runtime.app).get(`/api/v1/contacts?accountId=${accounts[0].id}`).expect(200)).body as Contact[];
    expect(contacts.filter((contact) => contact.phone === payload.phone)).toHaveLength(1);
    expect(contacts.find((contact) => contact.phone === payload.phone)).toMatchObject({
      crmContactId: expect.any(String),
      origin: "inbound_message"
    });
    const crmContacts = (await request(runtime.app).get("/api/v1/crm/contacts").expect(200)).body as Array<{ phone: string }>;
    expect(crmContacts.filter((contact) => contact.phone === payload.phone)).toHaveLength(1);
  });

  it("manually creates a contact and conversation idempotently within one account", async () => {
    const payload = {
      accountId: accounts[0].id,
      displayName: "Manual Contact",
      phone: "+14155552671",
      createCrmContact: false
    };
    const first = await request(runtime.app).post("/api/v1/contacts").send(payload).expect(201);
    const second = await request(runtime.app)
      .post("/api/v1/contacts")
      .send({ ...payload, displayName: "Manual Contact Updated" })
      .expect(201);

    expect(first.body.contact).toMatchObject({
      accountId: accounts[0].id,
      phone: payload.phone,
      origin: "manual",
      crmContactId: null
    });
    expect(second.body.contact.id).toBe(first.body.contact.id);
    expect(second.body.contact.displayName).toBe("Manual Contact Updated");
    expect(second.body.conversation.id).toBe(first.body.conversation.id);

    const contacts = (await request(runtime.app).get(`/api/v1/contacts?accountId=${accounts[0].id}`).expect(200)).body as Contact[];
    expect(contacts.filter((contact) => contact.phone === payload.phone)).toHaveLength(1);
  });

  it("claims concurrent same-phone contact creation only once", async () => {
    const payload = {
      accountId: accounts[0].id,
      displayName: "Concurrent Contact",
      phone: "+14155550198",
      createCrmContact: false
    };
    const [first, second] = await Promise.all([
      request(runtime.app).post("/api/v1/contacts").send(payload),
      request(runtime.app).post("/api/v1/contacts").send({ ...payload, displayName: "Concurrent Contact Updated" })
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.contact.id).toBe(second.body.contact.id);
    expect(first.body.conversation.id).toBe(second.body.conversation.id);
  });

  it("isolates the same manually added phone across accounts", async () => {
    const phone = "+14155552671";
    const firstAccountContacts = (
      await request(runtime.app).get(`/api/v1/contacts?accountId=${accounts[0].id}`).expect(200)
    ).body as Contact[];
    const first = firstAccountContacts.find((contact) => contact.phone === phone)!;
    const second = await request(runtime.app)
      .post("/api/v1/contacts")
      .send({ accountId: accounts[1].id, displayName: "Other Account Contact", phone })
      .expect(201);

    expect(second.body.contact.accountId).toBe(accounts[1].id);
    expect(second.body.contact.id).not.toBe(first.id);
    expect(second.body.conversation.accountId).toBe(accounts[1].id);
  });

  it("rejects non-E.164 manual contact numbers", async () => {
    const invalidPhones = ["14155552671", "+0123456789", "+123", "+1234567890123456", "+1 415 555 2671"];
    for (const phone of invalidPhones) {
      await request(runtime.app)
        .post("/api/v1/contacts")
        .send({ accountId: accounts[0].id, displayName: "Invalid Number", phone })
        .expect(400);
    }
  });

  it("optionally creates a CRM Sandbox record with a manual contact", async () => {
    const response = await request(runtime.app)
      .post("/api/v1/contacts")
      .send({
        accountId: accounts[0].id,
        displayName: "Manual CRM Contact",
        phone: "+61412345678",
        createCrmContact: true
      })
      .expect(201);

    expect(response.body.crmContact).toMatchObject({ phone: "+61412345678", name: "Manual CRM Contact" });
    expect(response.body.contact.crmContactId).toBe(response.body.crmContact.id);
  });

  it("creates a conversation idempotently for a synchronized contact without history", async () => {
    const contact = await runtime.repository.upsertContact({
      accountId: accounts[0].id,
      providerContactId: "81312345678@s.whatsapp.net",
      displayName: "Synced Without History",
      phone: "+81312345678",
      source: "demo",
      origin: "whatsapp_sync"
    });
    const first = await request(runtime.app).post(`/api/v1/contacts/${contact.id}/conversation`).expect(201);
    const second = await request(runtime.app).post(`/api/v1/contacts/${contact.id}/conversation`).expect(201);

    expect(first.body).toMatchObject({ accountId: accounts[0].id, contactId: contact.id });
    expect(second.body.id).toBe(first.body.id);
  });

  it("imports an existing CRM Sandbox contact into another account idempotently", async () => {
    const crmContacts = (await request(runtime.app).get("/api/v1/crm/contacts").expect(200)).body as Array<{
      id: string;
      phone: string;
    }>;
    const crmContact = crmContacts.find((contact) => contact.phone === "+34612140788")!;
    const first = await request(runtime.app)
      .post(`/api/v1/crm/contacts/${crmContact.id}/import`)
      .send({ accountId: accounts[1].id })
      .expect(201);
    const second = await request(runtime.app)
      .post(`/api/v1/crm/contacts/${crmContact.id}/import`)
      .send({ accountId: accounts[1].id })
      .expect(201);

    expect(first.body.contact).toMatchObject({
      accountId: accounts[1].id,
      phone: crmContact.phone,
      origin: "crm_import",
      crmContactId: crmContact.id
    });
    expect(second.body.contact.id).toBe(first.body.contact.id);
    expect(second.body.conversation.id).toBe(first.body.conversation.id);
  });

  it("protects a routed account from logout when deletion cannot succeed", async () => {
    const before = (await request(runtime.app).get("/api/v1/accounts").expect(200)).body as ChannelAccount[];
    expect(before.find((account) => account.id === accounts[0].id)?.status).toBe("connected");

    const rejected = await request(runtime.app).delete(`/api/v1/accounts/${accounts[0].id}`).expect(409);
    expect(rejected.body).toMatchObject({ routingReferences: expect.any(Number) });

    const after = (await request(runtime.app).get("/api/v1/accounts").expect(200)).body as ChannelAccount[];
    expect(after.find((account) => account.id === accounts[0].id)?.status).toBe("connected");
  });

  it("resolves preferred and fallback accounts from lead context", async () => {
    const response = await request(runtime.app)
      .post("/api/v1/routing/resolve")
      .send({ leadType: "批发", region: "欧洲" })
      .expect(200);
    expect(response.body.rule.name).toBe("欧洲批发线索");
    expect(response.body.account.id).toBe(accounts[0].id);
    expect(response.body.fallback.id).toBe(accounts[1].id);
    expect(response.body.selectionReason).toBe("preferred_online");
  });

  it("updates and deletes routing rules while selecting an online fallback", async () => {
    const offlineAccount = (
      await request(runtime.app)
        .post("/api/v1/accounts")
        .send({ name: "Offline official route", provider: "meta", purposeLabel: "Cutover test" })
        .expect(201)
    ).body as ChannelAccount;
    const created = await request(runtime.app)
      .post("/api/v1/routing/rules")
      .send({
        name: "Cutover route",
        leadType: "切换回归",
        region: "",
        preferredAccountId: offlineAccount.id,
        fallbackAccountId: accounts[1].id,
        priority: 1,
        enabled: true
      })
      .expect(201);

    const fallbackResolution = await request(runtime.app)
      .post("/api/v1/routing/resolve")
      .send({ leadType: "切换回归", region: "" })
      .expect(200);
    expect(fallbackResolution.body).toMatchObject({
      preferred: { id: offlineAccount.id, status: "unconfigured" },
      account: { id: accounts[1].id, status: "connected" },
      selectionReason: "fallback_online"
    });

    await request(runtime.app)
      .put(`/api/v1/routing/rules/${created.body.id}`)
      .send({
        name: "Cutover route updated",
        leadType: "切换回归",
        region: "",
        preferredAccountId: accounts[0].id,
        fallbackAccountId: offlineAccount.id,
        priority: 1,
        enabled: true
      })
      .expect(200);
    const preferredResolution = await request(runtime.app)
      .post("/api/v1/routing/resolve")
      .send({ leadType: "切换回归", region: "" })
      .expect(200);
    expect(preferredResolution.body).toMatchObject({
      account: { id: accounts[0].id },
      selectionReason: "preferred_online"
    });

    await request(runtime.app).delete(`/api/v1/routing/rules/${created.body.id}`).expect(204);
    await request(runtime.app).delete(`/api/v1/accounts/${offlineAccount.id}`).expect(204);
  });

  it("keeps message status monotonic under concurrent receipt updates", async () => {
    const conversations = (
      await request(runtime.app).get(`/api/v1/conversations?accountId=${accounts[0].id}`).expect(200)
    ).body as Conversation[];
    const message = await runtime.repository.createMessage({
      accountId: accounts[0].id,
      conversationId: conversations[0].id,
      clientMessageId: randomUUID(),
      direction: "outbound",
      body: "Status race",
      status: "accepted"
    });
    await Promise.all([
      runtime.repository.updateMessageStatusMonotonic(message.id, "accepted"),
      runtime.repository.updateMessageStatusMonotonic(message.id, "delivered"),
      runtime.repository.updateMessageStatusMonotonic(message.id, "read")
    ]);
    expect((await runtime.repository.getMessage(message.id))?.status).toBe("read");
    await runtime.repository.updateMessageStatusMonotonic(message.id, "failed");
    expect((await runtime.repository.getMessage(message.id))?.status).toBe("read");
  });
});

import type { AppConfig } from "../config.js";
import { databaseTimestamp, type Database } from "./database.js";
import { Repository } from "./repository.js";

export interface DemoSeedReport {
  created: boolean;
  accounts: number;
  contacts: number;
  conversations: number;
  messages: number;
  routingRules: number;
  crmContacts: number;
  mockProfiles: number;
}

interface CountRow {
  count: number | string;
}

async function countDemoRows(database: Database): Promise<Omit<DemoSeedReport, "created">> {
  const count = async (sql: string): Promise<number> => {
    const result = await database.query<CountRow>(sql);
    return Number(result.rows[0]?.count ?? 0);
  };
  return {
    accounts: await count("SELECT COUNT(*) AS count FROM channel_accounts WHERE provider='demo'"),
    contacts: await count(
      "SELECT COUNT(*) AS count FROM contacts c JOIN channel_accounts a ON a.id=c.account_id WHERE a.provider='demo'"
    ),
    conversations: await count(
      "SELECT COUNT(*) AS count FROM conversations c JOIN channel_accounts a ON a.id=c.account_id WHERE a.provider='demo'"
    ),
    messages: await count(
      "SELECT COUNT(*) AS count FROM messages m JOIN channel_accounts a ON a.id=m.account_id WHERE a.provider='demo'"
    ),
    routingRules: await count(
      `SELECT COUNT(*) AS count FROM routing_rules r
       WHERE EXISTS (
         SELECT 1 FROM channel_accounts a
         WHERE a.provider='demo' AND (a.id=r.preferred_account_id OR a.id=r.fallback_account_id)
       )`
    ),
    crmContacts: await count("SELECT COUNT(*) AS count FROM crm_contacts WHERE source='demo'"),
    mockProfiles: await count("SELECT COUNT(*) AS count FROM ai_provider_profiles WHERE kind='mock'")
  };
}

export async function seed(database: Database, _repository: Repository, _config: AppConfig): Promise<void> {
  await database.query(
    database.kind === "mysql"
      ? `INSERT IGNORE INTO translation_preferences(id,auto_translate,target_language,provider_id,crm_auto_create,updated_at)
         VALUES('default',0,'zh-CN',NULL,0,$1)`
      : `INSERT INTO translation_preferences(id,auto_translate,target_language,provider_id,crm_auto_create,updated_at)
         VALUES('default',0,'zh-CN',NULL,0,$1)
         ON CONFLICT(id) DO NOTHING`,
    [databaseTimestamp(new Date())]
  );
}

export async function seedDemo(
  database: Database,
  repository: Repository,
  config: Pick<AppConfig, "nodeEnv">
): Promise<DemoSeedReport> {
  if (config.nodeEnv === "production") {
    throw new Error("Demo seed is disabled in production");
  }

  const profiles = await repository.listAiProfiles();
  let mockProfile = profiles.find((profile) => profile.kind === "mock");
  if (!mockProfile) {
    mockProfile = await repository.createAiProfile({
      name: "本机 Mock 翻译",
      kind: "mock",
      model: "mock-translate-v1",
      ownerUserId: config.nodeEnv === "test" ? "test-user" : undefined
    });
  }

  await database.query(
    `UPDATE translation_preferences SET auto_translate=1,provider_id=$1,updated_at=$2
     WHERE id='default' AND provider_id IS NULL`,
    [mockProfile.id, databaseTimestamp(new Date())]
  );

  const existing = await countDemoRows(database);
  if (existing.accounts > 0) return { created: false, ...existing };

  const europe = await repository.createAccount({
    name: "欧洲销售",
    provider: "demo",
    phone: "+44 20 7946 0182",
    purposeLabel: "欧洲询盘",
    leadTypes: ["批发", "经销商"],
    region: "欧洲",
    priority: 10,
    riskAccepted: true,
    ownerUserId: config.nodeEnv === "test" ? "test-user" : undefined
  });
  const latam = await repository.createAccount({
    name: "拉美业务",
    provider: "demo",
    phone: "+52 55 1234 8068",
    purposeLabel: "拉美线索",
    leadTypes: ["零售", "样品"],
    region: "拉丁美洲",
    priority: 20,
    riskAccepted: true,
    ownerUserId: config.nodeEnv === "test" ? "test-user" : undefined
  });
  await repository.updateAccountStatus(europe.id, "connected", { phone: europe.phone });
  await repository.updateAccountStatus(latam.id, "connected", { phone: latam.phone });

  const sofia = await repository.upsertContact({
    accountId: europe.id,
    providerContactId: "34612140788@s.whatsapp.net",
    displayName: "Sofia Martinez",
    phone: "+34612140788",
    source: "demo"
  });
  const james = await repository.upsertContact({
    accountId: europe.id,
    providerContactId: "447700900312@s.whatsapp.net",
    displayName: "James Wilson",
    phone: "+447700900312",
    source: "demo"
  });
  const carlos = await repository.upsertContact({
    accountId: latam.id,
    providerContactId: "525512349311@s.whatsapp.net",
    displayName: "Carlos Mendoza",
    phone: "+525512349311",
    source: "demo"
  });

  const sofiaConversation = await repository.upsertConversation({
    accountId: europe.id,
    contactId: sofia.id,
    providerConversationId: sofia.providerContactId
  });
  const jamesConversation = await repository.upsertConversation({
    accountId: europe.id,
    contactId: james.id,
    providerConversationId: james.providerContactId
  });
  const carlosConversation = await repository.upsertConversation({
    accountId: latam.id,
    contactId: carlos.id,
    providerConversationId: carlos.providerContactId
  });

  const firstMessage = await repository.createMessage({
    accountId: europe.id,
    conversationId: sofiaConversation.id,
    providerMessageId: "demo-sofia-1",
    direction: "inbound",
    body: "Hola, nos interesan 500 unidades. ¿Podrían compartir el precio FOB?",
    status: "delivered",
    sourceLanguage: "es"
  });
  const firstTranslation = await repository.createPendingTranslation({
    messageId: firstMessage.id,
    sourceLanguage: "es",
    targetLanguage: "zh-CN",
    profileId: mockProfile.id,
    model: mockProfile.model,
    trigger: "automatic"
  });
  await repository.completeTranslation(firstTranslation.id, "您好，我们对 500 件产品感兴趣。可以提供 FOB 报价吗？", 28);

  await repository.createMessage({
    accountId: europe.id,
    conversationId: sofiaConversation.id,
    providerMessageId: "demo-sofia-2",
    direction: "outbound",
    body: "Thanks, Sofia. I will prepare the quotation today.",
    status: "read",
    sourceLanguage: "en"
  });
  await repository.createMessage({
    accountId: europe.id,
    conversationId: jamesConversation.id,
    providerMessageId: "demo-james-1",
    direction: "inbound",
    body: "Could you confirm the lead time for the custom packaging?",
    status: "delivered",
    sourceLanguage: "en"
  });
  const carlosMessage = await repository.createMessage({
    accountId: latam.id,
    conversationId: carlosConversation.id,
    providerMessageId: "demo-carlos-1",
    direction: "inbound",
    body: "Necesitamos muestras antes de confirmar el pedido.",
    status: "delivered",
    sourceLanguage: "es"
  });
  const carlosTranslation = await repository.createPendingTranslation({
    messageId: carlosMessage.id,
    sourceLanguage: "es",
    targetLanguage: "zh-CN",
    profileId: mockProfile.id,
    model: mockProfile.model,
    trigger: "automatic"
  });
  await repository.completeTranslation(carlosTranslation.id, "我们需要先收到样品，再确认订单。", 18);

  await repository.createRoutingRule({
    name: "欧洲批发线索",
    leadType: "批发",
    region: "欧洲",
    preferredAccountId: europe.id,
    fallbackAccountId: latam.id,
    priority: 10,
    enabled: true,
    ownerUserId: config.nodeEnv === "test" ? "test-user" : undefined
  });
  await repository.createRoutingRule({
    name: "拉美样品线索",
    leadType: "样品",
    region: "拉丁美洲",
    preferredAccountId: latam.id,
    fallbackAccountId: europe.id,
    priority: 20,
    enabled: true,
    ownerUserId: config.nodeEnv === "test" ? "test-user" : undefined
  });
  await repository.createCrmContact(sofia.id);

  return { created: true, ...(await countDemoRows(database)) };
}

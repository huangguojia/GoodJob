import { loadConfig } from "../config.js";
import { createDatabase } from "../db/database.js";
import { migrate } from "../db/migrate.js";
import { Repository } from "../db/repository.js";
import { ConversationIntelligenceService } from "../services/conversation-intelligence.js";

/** Creates inbound-only local data for CRM customer-detail UX acceptance. */
const config = loadConfig();
if (config.nodeEnv === "production") throw new Error("UX scenario is disabled in production");

const database = await createDatabase(config);
try {
  await migrate(database);
  const repository = new Repository(database);
  const existing = (await repository.listAccounts("u_admin")).find((account) => account.name === "Meta 入站体验账号");
  const account = existing ?? await repository.createAccount({
    name: "Meta 入站体验账号",
    provider: "meta",
    phone: "+491111111111",
    purposeLabel: "本地入站体验",
    leadTypes: ["询价", "样品", "批发"],
    region: "欧洲",
    priority: 1,
    riskAccepted: true,
    ownerUserId: "u_admin"
  });
  if (!existing || account.status !== "connected") await repository.updateAccountStatus(account.id, "connected", { phone: account.phone });
  const contact = await repository.upsertContact({
    accountId: account.id,
    providerContactId: "491234567890@s.whatsapp.net",
    displayName: "Maria Garcia",
    phone: "+491234567890",
    source: "meta",
    origin: "inbound_message"
  });
  const conversation = await repository.upsertConversation({ accountId: account.id, contactId: contact.id, providerConversationId: contact.providerContactId });
  const messages = [
    ["meta-ux-1", "Hello, we need 500 units of the LED engineering light. Please send your best FOB price.", "en"],
    ["meta-ux-2", "Could you confirm the lead time? We need samples before approving the order.", "en"],
    ["meta-ux-3", "Can we schedule a meeting on Thursday at 15:00 to review the quotation and payment terms?", "en"]
  ] as const;
  for (const [index, [providerMessageId, body, sourceLanguage]] of messages.entries()) {
    await repository.createMessage({
      accountId: account.id,
      conversationId: conversation.id,
      providerMessageId,
      direction: "inbound",
      body,
      status: "delivered",
      sourceLanguage,
      occurredAt: new Date(Date.now() - (messages.length - index) * 3_600_000).toISOString()
    });
  }
  await repository.createCrmContact(contact.id);
  const realtimeStub = { publish: () => undefined } as unknown as ConstructorParameters<typeof ConversationIntelligenceService>[1];
  const intelligence = new ConversationIntelligenceService(repository, realtimeStub);
  const result = await intelligence.analyzeConversation(conversation.id);
  console.log(JSON.stringify({ accountId: account.id, conversationId: conversation.id, contactId: contact.id, followups: result.followups.length }, null, 2));
} finally {
  await database.close();
}

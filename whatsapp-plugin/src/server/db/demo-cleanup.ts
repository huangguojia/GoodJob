import { createHash, randomUUID } from "node:crypto";
import type { Database, DatabaseTransaction } from "./database.js";

interface SnapshotRow {
  id: string;
  marker: string;
}

export interface DemoCleanupCounts {
  demoAccounts: number;
  demoContacts: number;
  demoConversations: number;
  demoMessages: number;
  demoTranslations: number;
  demoRoutingRules: number;
  blockedMixedRoutingRules: number;
  demoCrmContacts: number;
  removableMockProfiles: number;
  removableMockTranslations: number;
  blockedMockProfiles: number;
}

export interface ProtectedDataCounts {
  accounts: number;
  contacts: number;
  conversations: number;
  messages: number;
  translations: number;
  sessionKeys: number;
  crmContacts: number;
  aiProfiles: number;
  metaApps: number;
  metaCredentials: number;
  routingRules: number;
  blockedMixedRoutingRules: number;
}

export interface DemoCleanupPlan {
  planDigest: string;
  protectedDigest: string;
  counts: DemoCleanupCounts;
  protectedCounts: ProtectedDataCounts;
  hasTargets: boolean;
}

export interface DemoCleanupResult extends DemoCleanupPlan {
  applied: true;
  deleted: {
    accounts: number;
    routingRules: number;
    crmContacts: number;
    mockProfiles: number;
  };
  auditRecordsCreated: number;
}

interface InternalPlan {
  report: DemoCleanupPlan;
  targetSnapshot: Record<string, SnapshotRow[]>;
  protectedSnapshot: Record<string, SnapshotRow[]>;
}

function digest(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function snapshot(database: DatabaseTransaction, sql: string): Promise<SnapshotRow[]> {
  const result = await database.query<SnapshotRow>(sql);
  return result.rows.map((row) => ({ id: String(row.id), marker: String(row.marker ?? "") }));
}

async function buildInternalPlan(database: DatabaseTransaction): Promise<InternalPlan> {
  const targetSnapshot = {
    accounts: await snapshot(
      database,
      "SELECT id,updated_at::text AS marker FROM channel_accounts WHERE provider='demo' ORDER BY id"
    ),
    contacts: await snapshot(
      database,
      `SELECT c.id,c.updated_at::text AS marker FROM contacts c
       JOIN channel_accounts a ON a.id=c.account_id WHERE a.provider='demo' ORDER BY c.id`
    ),
    conversations: await snapshot(
      database,
      `SELECT c.id,c.updated_at::text AS marker FROM conversations c
       JOIN channel_accounts a ON a.id=c.account_id WHERE a.provider='demo' ORDER BY c.id`
    ),
    messages: await snapshot(
      database,
      `SELECT m.id,m.created_at::text AS marker FROM messages m
       JOIN channel_accounts a ON a.id=m.account_id WHERE a.provider='demo' ORDER BY m.id`
    ),
    translations: await snapshot(
      database,
      `SELECT t.id,t.updated_at::text AS marker FROM translations t
       JOIN messages m ON m.id=t.message_id
       JOIN channel_accounts a ON a.id=m.account_id WHERE a.provider='demo' ORDER BY t.id`
    ),
    routingRules: await snapshot(
      database,
      `SELECT r.id,r.updated_at::text AS marker FROM routing_rules r
       WHERE EXISTS (
         SELECT 1 FROM channel_accounts a
         WHERE a.provider='demo' AND (a.id=r.preferred_account_id OR a.id=r.fallback_account_id)
       ) AND NOT EXISTS (
         SELECT 1 FROM channel_accounts a
         WHERE a.provider<>'demo' AND (a.id=r.preferred_account_id OR a.id=r.fallback_account_id)
       ) ORDER BY r.id`
    ),
    crmContacts: await snapshot(
      database,
      `SELECT crm.id,crm.created_at::text AS marker FROM crm_contacts crm
       WHERE crm.source='demo' OR EXISTS (
         SELECT 1 FROM contacts c JOIN channel_accounts a ON a.id=c.account_id
         WHERE a.provider='demo' AND c.id=crm.source_contact_id
       ) ORDER BY crm.id`
    ),
    removableMockProfiles: await snapshot(
      database,
      `SELECT p.id,p.updated_at::text AS marker FROM ai_provider_profiles p
       WHERE p.kind='mock'
         AND NOT EXISTS (SELECT 1 FROM translation_preferences pref WHERE pref.provider_id=p.id)
         AND NOT EXISTS (
           SELECT 1 FROM translations t
           JOIN messages m ON m.id=t.message_id
           JOIN channel_accounts a ON a.id=m.account_id
           WHERE t.profile_id=p.id AND a.provider<>'demo'
         ) ORDER BY p.id`
    ),
    removableMockTranslations: await snapshot(
      database,
      `SELECT t.id,t.updated_at::text AS marker FROM translations t
       JOIN ai_provider_profiles p ON p.id=t.profile_id
       JOIN messages m ON m.id=t.message_id
       JOIN channel_accounts a ON a.id=m.account_id
       WHERE p.kind='mock' AND a.provider='demo'
         AND NOT EXISTS (SELECT 1 FROM translation_preferences pref WHERE pref.provider_id=p.id)
         AND NOT EXISTS (
           SELECT 1 FROM translations real_translation
           JOIN messages real_message ON real_message.id=real_translation.message_id
           JOIN channel_accounts real_account ON real_account.id=real_message.account_id
           WHERE real_translation.profile_id=p.id AND real_account.provider<>'demo'
         )
       ORDER BY t.id`
    ),
    blockedMockProfiles: await snapshot(
      database,
      `SELECT p.id,p.updated_at::text AS marker FROM ai_provider_profiles p
       WHERE p.kind='mock' AND (
         EXISTS (SELECT 1 FROM translation_preferences pref WHERE pref.provider_id=p.id)
         OR EXISTS (
           SELECT 1 FROM translations t
           JOIN messages m ON m.id=t.message_id
           JOIN channel_accounts a ON a.id=m.account_id
           WHERE t.profile_id=p.id AND a.provider<>'demo'
         )
       ) ORDER BY p.id`
    )
  };

  const protectedSnapshot = {
    accounts: await snapshot(
      database,
      "SELECT id,updated_at::text AS marker FROM channel_accounts WHERE provider<>'demo' ORDER BY id"
    ),
    contacts: await snapshot(
      database,
      `SELECT c.id,c.updated_at::text AS marker FROM contacts c
       JOIN channel_accounts a ON a.id=c.account_id WHERE a.provider<>'demo' ORDER BY c.id`
    ),
    conversations: await snapshot(
      database,
      `SELECT c.id,c.updated_at::text AS marker FROM conversations c
       JOIN channel_accounts a ON a.id=c.account_id WHERE a.provider<>'demo' ORDER BY c.id`
    ),
    messages: await snapshot(
      database,
      `SELECT m.id,m.created_at::text AS marker FROM messages m
       JOIN channel_accounts a ON a.id=m.account_id WHERE a.provider<>'demo' ORDER BY m.id`
    ),
    translations: await snapshot(
      database,
      `SELECT t.id,t.updated_at::text AS marker FROM translations t
       JOIN messages m ON m.id=t.message_id
       JOIN channel_accounts a ON a.id=m.account_id WHERE a.provider<>'demo' ORDER BY t.id`
    ),
    sessionKeys: await snapshot(
      database,
      `SELECT CONCAT(k.account_id,':',k.key_type,':',k.key_id) AS id,
         CONCAT(k.updated_at::text,':',k.cipher_text) AS marker
       FROM provider_session_keys k JOIN channel_accounts a ON a.id=k.account_id
       WHERE a.provider<>'demo' ORDER BY id`
    ),
    crmContacts: await snapshot(
      database,
      `SELECT crm.id,crm.created_at::text AS marker FROM crm_contacts crm
       WHERE crm.source<>'demo' AND NOT EXISTS (
         SELECT 1 FROM contacts c JOIN channel_accounts a ON a.id=c.account_id
         WHERE a.provider='demo' AND c.id=crm.source_contact_id
       ) ORDER BY crm.id`
    ),
    aiProfiles: await snapshot(
      database,
      `SELECT p.id,p.updated_at::text AS marker FROM ai_provider_profiles p
       WHERE p.kind<>'mock'
         OR EXISTS (SELECT 1 FROM translation_preferences pref WHERE pref.provider_id=p.id)
         OR EXISTS (
           SELECT 1 FROM translations t
           JOIN messages m ON m.id=t.message_id
           JOIN channel_accounts a ON a.id=m.account_id
           WHERE t.profile_id=p.id AND a.provider<>'demo'
         ) ORDER BY p.id`
    ),
    metaApps: await snapshot(
      database,
      "SELECT id,updated_at::text AS marker FROM meta_app_configs ORDER BY id"
    ),
    metaCredentials: await snapshot(
      database,
      `SELECT c.account_id AS id,c.updated_at::text AS marker FROM meta_account_credentials c
       JOIN channel_accounts a ON a.id=c.account_id WHERE a.provider<>'demo' ORDER BY c.account_id`
    ),
    routingRules: await snapshot(
      database,
      `SELECT r.id,
         CONCAT(
           r.updated_at::text,':',r.name,':',r.lead_type,':',r.region,':',
           r.preferred_account_id,':',COALESCE(r.fallback_account_id,''),':',
           r.priority::text,':',r.enabled::text
         ) AS marker
       FROM routing_rules r
       WHERE NOT (
         EXISTS (
           SELECT 1 FROM channel_accounts a
           WHERE a.provider='demo' AND (a.id=r.preferred_account_id OR a.id=r.fallback_account_id)
         ) AND NOT EXISTS (
           SELECT 1 FROM channel_accounts a
           WHERE a.provider<>'demo' AND (a.id=r.preferred_account_id OR a.id=r.fallback_account_id)
         )
       ) ORDER BY r.id`
    ),
    blockedMixedRoutingRules: await snapshot(
      database,
      `SELECT r.id,
         CONCAT(
           r.updated_at::text,':',r.name,':',r.lead_type,':',r.region,':',
           r.preferred_account_id,':',COALESCE(r.fallback_account_id,''),':',
           r.priority::text,':',r.enabled::text
         ) AS marker
       FROM routing_rules r
       WHERE EXISTS (
         SELECT 1 FROM channel_accounts a
         WHERE a.provider='demo' AND (a.id=r.preferred_account_id OR a.id=r.fallback_account_id)
       ) AND EXISTS (
         SELECT 1 FROM channel_accounts a
         WHERE a.provider<>'demo' AND (a.id=r.preferred_account_id OR a.id=r.fallback_account_id)
       ) ORDER BY r.id`
    )
  };

  const counts: DemoCleanupCounts = {
    demoAccounts: targetSnapshot.accounts.length,
    demoContacts: targetSnapshot.contacts.length,
    demoConversations: targetSnapshot.conversations.length,
    demoMessages: targetSnapshot.messages.length,
    demoTranslations: targetSnapshot.translations.length,
    demoRoutingRules: targetSnapshot.routingRules.length,
    blockedMixedRoutingRules: protectedSnapshot.blockedMixedRoutingRules.length,
    demoCrmContacts: targetSnapshot.crmContacts.length,
    removableMockProfiles: targetSnapshot.removableMockProfiles.length,
    removableMockTranslations: targetSnapshot.removableMockTranslations.length,
    blockedMockProfiles: targetSnapshot.blockedMockProfiles.length
  };
  const protectedCounts = Object.fromEntries(
    Object.entries(protectedSnapshot).map(([key, rows]) => [key, rows.length])
  ) as unknown as ProtectedDataCounts;
  const protectedDigest = digest(protectedSnapshot);
  const planDigest = digest({ targetSnapshot, protectedDigest });
  const hasTargets =
    counts.demoAccounts > 0 ||
    counts.demoRoutingRules > 0 ||
    counts.demoCrmContacts > 0 ||
    counts.removableMockProfiles > 0;

  return {
    targetSnapshot,
    protectedSnapshot,
    report: { planDigest, protectedDigest, counts, protectedCounts, hasTargets }
  };
}

export async function planDemoCleanup(database: DatabaseTransaction): Promise<DemoCleanupPlan> {
  return (await buildInternalPlan(database)).report;
}

async function deleteReturningCount(database: DatabaseTransaction, sql: string): Promise<number> {
  const result = await database.query<{ id: string }>(sql);
  return result.rows.length;
}

export async function applyDemoCleanup(database: Database, expectedPlanDigest: string): Promise<DemoCleanupResult> {
  if (!/^[a-f0-9]{64}$/u.test(expectedPlanDigest)) {
    throw new Error("A valid cleanup plan digest is required");
  }

  return database.transaction(async (transaction) => {
    if (transaction.kind === "postgres") {
      await transaction.exec(`
        LOCK TABLE channel_accounts,provider_session_keys,contacts,conversations,messages,translations,
          routing_rules,crm_contacts,ai_provider_profiles,translation_preferences,meta_app_configs,
          meta_account_credentials IN SHARE ROW EXCLUSIVE MODE;
      `);
    }

    const before = await buildInternalPlan(transaction);
    if (before.report.planDigest !== expectedPlanDigest) {
      throw new Error("Cleanup plan changed; run a new dry-run before applying");
    }

    if (before.report.counts.blockedMixedRoutingRules > 0) {
      throw new Error(
        "Cleanup blocked: routing rules that mix Demo and non-Demo accounts must be resolved manually"
      );
    }

    if (!before.report.hasTargets) {
      return {
        ...before.report,
        applied: true,
        deleted: { accounts: 0, routingRules: 0, crmContacts: 0, mockProfiles: 0 },
        auditRecordsCreated: 0
      };
    }

    const routingRules = await deleteReturningCount(
      transaction,
      `DELETE FROM routing_rules r WHERE EXISTS (
         SELECT 1 FROM channel_accounts a
         WHERE a.provider='demo' AND (a.id=r.preferred_account_id OR a.id=r.fallback_account_id)
       ) AND NOT EXISTS (
         SELECT 1 FROM channel_accounts a
         WHERE a.provider<>'demo' AND (a.id=r.preferred_account_id OR a.id=r.fallback_account_id)
       ) RETURNING r.id`
    );
    const crmContacts = await deleteReturningCount(
      transaction,
      `DELETE FROM crm_contacts crm WHERE crm.source='demo' OR EXISTS (
         SELECT 1 FROM contacts c JOIN channel_accounts a ON a.id=c.account_id
         WHERE a.provider='demo' AND c.id=crm.source_contact_id
       ) RETURNING crm.id`
    );
    const accounts = await deleteReturningCount(
      transaction,
      "DELETE FROM channel_accounts WHERE provider='demo' RETURNING id"
    );
    const mockProfiles = await deleteReturningCount(
      transaction,
      `DELETE FROM ai_provider_profiles p WHERE p.kind='mock'
         AND NOT EXISTS (SELECT 1 FROM translation_preferences pref WHERE pref.provider_id=p.id)
         AND NOT EXISTS (SELECT 1 FROM translations t WHERE t.profile_id=p.id)
       RETURNING p.id`
    );

    const deleted = { accounts, routingRules, crmContacts, mockProfiles };
    if (
      accounts !== before.report.counts.demoAccounts ||
      routingRules !== before.report.counts.demoRoutingRules ||
      crmContacts !== before.report.counts.demoCrmContacts ||
      mockProfiles !== before.report.counts.removableMockProfiles
    ) {
      throw new Error("Cleanup target counts changed during execution");
    }

    const after = await buildInternalPlan(transaction);
    if (after.report.protectedDigest !== before.report.protectedDigest) {
      throw new Error("Protected data changed during cleanup");
    }

    await transaction.query(
      `INSERT INTO audit_logs(id,action,target_type,target_id,result,details_json,created_at)
       VALUES($1,'maintenance.demo_cleanup','system',$2,'success',$3,$4)`,
      [
        randomUUID(),
        randomUUID(),
        JSON.stringify({ planDigest: before.report.planDigest, deleted, cascadeCounts: before.report.counts }),
        new Date().toISOString()
      ]
    );

    return { ...before.report, applied: true, deleted, auditRecordsCreated: 1 };
  });
}

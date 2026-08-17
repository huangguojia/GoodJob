import { randomUUID } from "node:crypto";
import type mysql from "mysql2/promise";
import type { SessionUser } from "../types.js";
import {
  graphSnapshot,
  graphStartNode,
  nextApprovalNode,
  nextApprovalNodeAfter,
  normalizeApprovalGraph,
  validateApprovalGraph,
  workflowMatches,
  type ApprovalGraph
} from "./approval-graph.js";

type Queryable = mysql.Pool | mysql.PoolConnection;
type ApprovalStatus = "draft" | "running" | "approved" | "rejected" | "withdrawn" | "cancelled" | "failed";
type TaskDecision = "approve" | "reject";
type Context = { requestId?: string };

export interface ApprovalService {
  listWorkflows(actor: SessionUser): Promise<Record<string, unknown>>;
  getWorkflow(actor: SessionUser, id: string): Promise<Record<string, unknown>>;
  createWorkflow(actor: SessionUser, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateWorkflow(actor: SessionUser, id: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  resolveWorkflow(actor: SessionUser, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  validateWorkflow(actor: SessionUser, id: string): Promise<Record<string, unknown>>;
  publishWorkflow(actor: SessionUser, id: string): Promise<Record<string, unknown>>;
  listInstances(actor: SessionUser, status?: string): Promise<Record<string, unknown>>;
  getInstance(actor: SessionUser, id: string): Promise<Record<string, unknown>>;
  createInstance(actor: SessionUser, input: Record<string, unknown>, context?: Context): Promise<Record<string, unknown>>;
  withdrawInstance(actor: SessionUser, id: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  remindInstance(actor: SessionUser, id: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  listTasks(actor: SessionUser, status?: string): Promise<Record<string, unknown>>;
  decideTask(actor: SessionUser, id: string, decision: TaskDecision, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  transferTask(actor: SessionUser, id: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  addApprover(actor: SessionUser, id: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  commentTask(actor: SessionUser, id: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function id(prefix: string) { return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 36)}`; }
function one<T>(value: unknown) { return (value as T[])[0]; }
function rows<T>(value: unknown) { return value as T[]; }
function json(value: unknown) { return JSON.stringify(value ?? null); }
function parsed<T>(value: unknown, fallback: T): T {
  if (value && typeof value === "object") return value as T;
  try { return JSON.parse(String(value || "")) as T; } catch { return fallback; }
}
function fail(status: number, message: string, code = "APPROVAL_ERROR"): never {
  throw Object.assign(new Error(message), { status, code });
}
function text(value: unknown, max: number, required = false) {
  const result = String(value || "").trim().slice(0, max);
  if (required && !result) fail(400, "必填信息不完整", "APPROVAL_INPUT_INVALID");
  return result;
}
function workflowGraph(input: Record<string, unknown>) {
  const graph = normalizeApprovalGraph(input);
  if (!graph.nodes.length) fail(400, "审批流程至少需要一个处理节点", "APPROVAL_WORKFLOW_EMPTY");
  return graph;
}

export async function ensureApprovalSchema(pool: mysql.Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS approval_workflow_definitions (
    id VARCHAR(90) PRIMARY KEY, tenant_id VARCHAR(64) NOT NULL, code VARCHAR(80) NOT NULL,
    name VARCHAR(160) NOT NULL, business_type VARCHAR(60) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'draft',
    current_version_id VARCHAR(90) NULL, allow_parallel BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(90) NOT NULL, updated_by VARCHAR(90) NOT NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_approval_workflow_code(tenant_id, code), INDEX idx_approval_workflow_status(tenant_id, status),
    CONSTRAINT fk_approval_workflow_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const definitionColumns = [
    ["draft_version_id", "VARCHAR(90) NULL AFTER current_version_id"],
    ["priority", "INT NOT NULL DEFAULT 100 AFTER allow_parallel"],
    ["is_default", "BOOLEAN NOT NULL DEFAULT FALSE AFTER priority"]
  ] as const;
  for (const [column, ddl] of definitionColumns) {
    const [existing] = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='approval_workflow_definitions' AND column_name=? LIMIT 1`,
      [column]
    );
    if (!one(existing)) await pool.query(`ALTER TABLE approval_workflow_definitions ADD COLUMN ${column} ${ddl}`);
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS approval_workflow_versions (
    id VARCHAR(90) PRIMARY KEY, tenant_id VARCHAR(64) NOT NULL, definition_id VARCHAR(90) NOT NULL,
    version_no INT NOT NULL, trigger_config_json JSON NOT NULL, form_schema_json JSON NOT NULL,
    snapshot_json JSON NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'draft', published_by VARCHAR(90) NULL,
    published_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_approval_workflow_version(tenant_id, definition_id, version_no),
    CONSTRAINT fk_approval_version_definition FOREIGN KEY (definition_id) REFERENCES approval_workflow_definitions(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS approval_nodes (
    id VARCHAR(90) PRIMARY KEY, tenant_id VARCHAR(64) NOT NULL, workflow_version_id VARCHAR(90) NOT NULL,
    node_type VARCHAR(20) NOT NULL DEFAULT 'approval', name VARCHAR(120) NOT NULL,
    approver_strategy VARCHAR(40) NOT NULL, approver_config_json JSON NOT NULL,
    approval_mode VARCHAR(20) NOT NULL DEFAULT 'single', timeout_config_json JSON NOT NULL, sort_order INT NOT NULL,
    INDEX idx_approval_nodes_version(tenant_id, workflow_version_id, sort_order),
    CONSTRAINT fk_approval_node_version FOREIGN KEY (workflow_version_id) REFERENCES approval_workflow_versions(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS approval_instances (
    id VARCHAR(90) PRIMARY KEY, tenant_id VARCHAR(64) NOT NULL, workflow_definition_id VARCHAR(90) NOT NULL,
    workflow_version_id VARCHAR(90) NOT NULL, business_type VARCHAR(60) NOT NULL, business_id VARCHAR(120) NOT NULL DEFAULT '',
    applicant_membership_id VARCHAR(90) NOT NULL, applicant_org_unit_id VARCHAR(90) NULL,
    title VARCHAR(220) NOT NULL, summary VARCHAR(500) NOT NULL DEFAULT '', form_data_json JSON NOT NULL,
    business_snapshot_json JSON NOT NULL, status VARCHAR(20) NOT NULL, current_node_ids_json JSON NOT NULL,
    idempotency_key VARCHAR(160) NOT NULL, version_no BIGINT NOT NULL DEFAULT 1,
    submitted_at DATETIME(3) NOT NULL, completed_at DATETIME(3) NULL, updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_approval_instance_idempotency(tenant_id, applicant_membership_id, idempotency_key),
    INDEX idx_approval_instance_status(tenant_id, status, updated_at),
    CONSTRAINT fk_approval_instance_workflow FOREIGN KEY (workflow_definition_id) REFERENCES approval_workflow_definitions(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS approval_tasks (
    id VARCHAR(90) PRIMARY KEY, tenant_id VARCHAR(64) NOT NULL, instance_id VARCHAR(90) NOT NULL, node_id VARCHAR(90) NOT NULL,
    assignee_membership_id VARCHAR(90) NOT NULL, delegated_from VARCHAR(90) NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending',
    due_at DATETIME(3) NULL, acted_at DATETIME(3) NULL, version_no BIGINT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL,
    INDEX idx_approval_task_assignee(tenant_id, assignee_membership_id, status, created_at),
    CONSTRAINT fk_approval_task_instance FOREIGN KEY (instance_id) REFERENCES approval_instances(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS approval_actions (
    id VARCHAR(90) PRIMARY KEY, tenant_id VARCHAR(64) NOT NULL, instance_id VARCHAR(90) NOT NULL, task_id VARCHAR(90) NULL,
    action_type VARCHAR(30) NOT NULL, actor_membership_id VARCHAR(90) NOT NULL, target_membership_id VARCHAR(90) NULL,
    comment_text VARCHAR(1000) NOT NULL DEFAULT '', idempotency_key VARCHAR(160) NOT NULL, metadata_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL, UNIQUE KEY uk_approval_action_idempotency(tenant_id, instance_id, action_type, idempotency_key),
    INDEX idx_approval_action_instance(tenant_id, instance_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS approval_delegations (
    id VARCHAR(90) PRIMARY KEY, tenant_id VARCHAR(64) NOT NULL, delegator_membership_id VARCHAR(90) NOT NULL,
    delegate_membership_id VARCHAR(90) NOT NULL, business_type VARCHAR(60) NOT NULL DEFAULT '*',
    starts_at DATETIME(3) NOT NULL, ends_at DATETIME(3) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'active', created_at DATETIME(3) NOT NULL,
    INDEX idx_approval_delegation_active(tenant_id, delegator_membership_id, status, starts_at, ends_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS approval_outbox_events (
    id VARCHAR(90) PRIMARY KEY, tenant_id VARCHAR(64) NOT NULL, instance_id VARCHAR(90) NOT NULL,
    event_type VARCHAR(80) NOT NULL, aggregate_type VARCHAR(60) NOT NULL, aggregate_id VARCHAR(120) NOT NULL,
    payload_json JSON NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', attempt_count INT NOT NULL DEFAULT 0,
    available_at DATETIME(3) NOT NULL, processed_at DATETIME(3) NULL, last_error VARCHAR(500) NOT NULL DEFAULT '', created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_approval_outbox_event(instance_id, event_type), INDEX idx_approval_outbox_pending(status, available_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

async function ensureApprovalUniqueIndex(
  pool: mysql.Pool,
  table: string,
  indexName: string,
  columns: string[]
) {
  const [result] = await pool.query(
    `SELECT column_name AS columnName, non_unique AS nonUnique
       FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?
      ORDER BY seq_in_index`,
    [table, indexName]
  );
  const current = (result as Array<{ columnName: string; nonUnique: number }>);
  if (current.length > 0
    && current.every((row) => Number(row.nonUnique) === 0)
    && current.length === columns.length
    && current.every((row, index) => row.columnName === columns[index])) return;
  if (current.length > 0) {
    await pool.query(`ALTER TABLE \`${table}\` DROP INDEX \`${indexName}\``);
  }
  await pool.query(
    `ALTER TABLE \`${table}\` ADD UNIQUE KEY \`${indexName}\` (${columns.map((column) => `\`${column}\``).join(", ")})`
  );
}

export async function ensureApprovalIndexes(pool: mysql.Pool) {
  await ensureApprovalUniqueIndex(pool, "approval_actions", "uk_approval_action_idempotency", [
    "tenant_id", "instance_id", "action_type", "idempotency_key"
  ]);
}

async function membership(queryable: Queryable, actor: SessionUser) {
  const [result] = await queryable.query(
    `SELECT id, primary_org_unit_id FROM tenant_memberships WHERE tenant_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
    [actor.teamId, actor.id]
  );
  return one<{ id: string; primary_org_unit_id: string | null }>(result) || fail(403, "当前账号没有有效公司成员身份");
}

async function resolveApprovers(queryable: Queryable, actor: SessionUser, node: Record<string, unknown>, applicantMembershipId = "") {
  const config = parsed<Record<string, unknown>>(node.approver_config_json, {});
  const strategy = String(node.approver_strategy || "requester_manager");
  let result: unknown = [];
  if (strategy === "specific_member") {
    const ids = Array.isArray(config.membershipIds) ? config.membershipIds.map(String) : [];
    if (ids.length) [result] = await queryable.query(
      `SELECT id FROM tenant_memberships WHERE tenant_id = ? AND status = 'active' AND id IN (${ids.map(() => "?").join(",")})`,
      [actor.teamId, ...ids]
    );
  } else if (strategy === "role_in_tenant") {
    [result] = await queryable.query(
      `SELECT DISTINCT mra.membership_id AS id FROM roles r JOIN member_role_assignments mra
       ON mra.tenant_id = r.tenant_id AND mra.role_id = r.id AND mra.status = 'active'
       JOIN tenant_memberships tm ON tm.tenant_id = mra.tenant_id AND tm.id = mra.membership_id AND tm.status = 'active'
       WHERE r.tenant_id = ? AND r.code = ? AND r.status = 'active'`,
      [actor.teamId, text(config.roleCode, 80, true)]
    );
  } else if (strategy === "permission_holder") {
    [result] = await queryable.query(
      `SELECT DISTINCT mra.membership_id AS id FROM member_role_assignments mra
       JOIN role_permission_bindings rpb ON rpb.tenant_id = mra.tenant_id AND rpb.role_id = mra.role_id
       JOIN tenant_memberships tm ON tm.tenant_id = mra.tenant_id AND tm.id = mra.membership_id AND tm.status = 'active'
       WHERE mra.tenant_id = ? AND mra.status = 'active' AND rpb.permission_code = ?`,
      [actor.teamId, text(config.permissionCode, 120, true)]
    );
  } else {
    const applicant = await membership(queryable, actor);
    [result] = await queryable.query(
      `SELECT DISTINCT leader.membership_id AS id, applicant.relation_type
       FROM organization_memberships applicant
       JOIN organization_memberships leader
         ON leader.tenant_id = applicant.tenant_id AND leader.org_unit_id = applicant.org_unit_id
         AND leader.is_leader = TRUE
         AND (leader.valid_from IS NULL OR leader.valid_from <= NOW(3))
         AND (leader.valid_until IS NULL OR leader.valid_until > NOW(3))
       JOIN organization_units ou
         ON ou.tenant_id = applicant.tenant_id AND ou.id = applicant.org_unit_id AND ou.status = 'active'
       JOIN tenant_memberships tm
         ON tm.tenant_id = leader.tenant_id AND tm.id = leader.membership_id AND tm.status = 'active'
       WHERE applicant.tenant_id = ? AND applicant.membership_id = ?
         AND (applicant.valid_from IS NULL OR applicant.valid_from <= NOW(3))
         AND (applicant.valid_until IS NULL OR applicant.valid_until > NOW(3))
       ORDER BY CASE applicant.relation_type WHEN 'primary' THEN 0 ELSE 1 END`,
      [actor.teamId, applicant.id]
    );
  }
  const ids = [...new Set(rows<{ id: string }>(result).map((item) => item.id).filter(Boolean))];
  const noSelf = config.allowSelfApproval === true ? ids : ids.filter((item) => item !== applicantMembershipId);
  if (!noSelf.length) fail(409, `节点“${String(node.name || "审批")}”未解析到有效审批人`, "APPROVER_NOT_FOUND");
  return noSelf;
}

function publicWorkflow(row: Record<string, unknown>) {
  const snapshot = parsed<Record<string, unknown>>(row.snapshot_json, {});
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : parsed(row.nodes_json, []);
  const edges = Array.isArray(snapshot.edges) ? snapshot.edges : [];
  return {
    id: row.id, code: row.code, name: row.name, businessType: row.business_type,
    status: row.status, currentVersionId: row.current_version_id || "", draftVersionId: row.draft_version_id || "",
    versionNo: Number(row.version_no || 0), nodeCount: Array.isArray(nodes) ? nodes.length : 0,
    allowParallel: Boolean(row.allow_parallel), createdAt: row.created_at, updatedAt: row.updated_at,
    priority: Number(row.priority || 100), isDefault: Boolean(row.is_default),
    triggerConfig: parsed(row.trigger_config_json, snapshot.triggerConfig && typeof snapshot.triggerConfig === "object" ? snapshot.triggerConfig : {}),
    formSchema: parsed(row.form_schema_json, snapshot.formSchema && typeof snapshot.formSchema === "object" ? snapshot.formSchema : {}),
    nodes, edges
  };
}

function publicInstance(row: Record<string, unknown>) {
  return {
    id: row.id, workflowId: row.workflow_definition_id, workflowName: row.workflow_name || "",
    businessType: row.business_type, businessId: row.business_id, title: row.title, summary: row.summary,
    status: row.status, version: Number(row.version_no || 1), applicantName: row.applicant_name || "",
    applicantMembershipId: row.applicant_membership_id, currentNodeIds: parsed(row.current_node_ids_json, []),
    submittedAt: row.submitted_at, completedAt: row.completed_at || "", updatedAt: row.updated_at
  };
}

export function createMysqlApprovalService(pool: mysql.Pool): ApprovalService {
  async function workflowDetail(actor: SessionUser, workflowId: string) {
    const [result] = await pool.query(
      `SELECT d.*, v.version_no, v.trigger_config_json, v.form_schema_json, v.snapshot_json
       FROM approval_workflow_definitions d
       LEFT JOIN approval_workflow_versions v ON v.id=COALESCE(d.draft_version_id,d.current_version_id,
         (SELECT id FROM approval_workflow_versions WHERE definition_id=d.id ORDER BY version_no DESC LIMIT 1))
       WHERE d.tenant_id=? AND d.id=? LIMIT 1`, [actor.teamId, workflowId]
    );
    const row = one<Record<string, unknown>>(result) || fail(404, "审批流程不存在");
    return publicWorkflow(row);
  }

  async function instanceRows(actor: SessionUser, where = "", values: unknown[] = []) {
    const member = await membership(pool, actor);
    const tenantWide = Boolean(actor.iamDataScope?.tenantWide);
    const [result] = await pool.query(
      `SELECT i.*, d.name AS workflow_name, u.name AS applicant_name FROM approval_instances i
       JOIN approval_workflow_definitions d ON d.tenant_id=i.tenant_id AND d.id=i.workflow_definition_id
       JOIN tenant_memberships tm ON tm.tenant_id=i.tenant_id AND tm.id=i.applicant_membership_id
       JOIN users u ON u.id=tm.user_id
       WHERE i.tenant_id=? ${tenantWide ? "" : "AND (i.applicant_membership_id=? OR EXISTS (SELECT 1 FROM approval_tasks at WHERE at.tenant_id=i.tenant_id AND at.instance_id=i.id AND at.assignee_membership_id=?))"}
       ${where} ORDER BY i.updated_at DESC LIMIT 300`,
      [actor.teamId, ...(tenantWide ? [] : [member.id, member.id]), ...values]
    );
    return rows<Record<string, unknown>>(result);
  }

  async function actionTransaction(actor: SessionUser, taskId: string, kind: TaskDecision, input: Record<string, unknown>) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const member = await membership(connection, actor);
      const [taskResult] = await connection.query(
        `SELECT t.*, i.status AS instance_status, i.business_type, i.business_id, i.applicant_membership_id,
           i.form_data_json,i.business_snapshot_json,i.workflow_version_id,n.approval_mode,n.sort_order
         FROM approval_tasks t JOIN approval_instances i ON i.id=t.instance_id AND i.tenant_id=t.tenant_id
         JOIN approval_nodes n ON n.id=t.node_id AND n.tenant_id=t.tenant_id
         WHERE t.tenant_id=? AND t.id=? FOR UPDATE`, [actor.teamId, taskId]
      );
      const task = one<Record<string, unknown>>(taskResult) || fail(404, "审批任务不存在");
      if (task.assignee_membership_id !== member.id) fail(403, "该审批任务未分配给当前成员");
      if (task.status !== "pending" || task.instance_status !== "running") fail(409, "审批任务状态已变化，请刷新后重试");
      const expectedVersion = Number(input.version || 0);
      if (expectedVersion && expectedVersion !== Number(task.version_no)) fail(409, "审批任务已被更新，请刷新后重试", "APPROVAL_VERSION_CONFLICT");
      const key = text(input.idempotencyKey, 160, true);
      const note = text(input.comment, 1000);
      await connection.query(`UPDATE approval_tasks SET status=?, acted_at=NOW(3), version_no=version_no+1 WHERE tenant_id=? AND id=? AND status='pending'`, [kind === "approve" ? "approved" : "rejected", actor.teamId, taskId]);
      await connection.query(`INSERT INTO approval_actions
        (id,tenant_id,instance_id,task_id,action_type,actor_membership_id,target_membership_id,comment_text,idempotency_key,metadata_json,created_at)
        VALUES (?,?,?,?,?,?,NULL,?,?,?,NOW(3))`, [id("apact"), actor.teamId, task.instance_id, taskId, kind, member.id, note, key, json({ taskVersion: task.version_no })]);
      if (kind === "reject") {
        await connection.query(`UPDATE approval_tasks SET status='cancelled',version_no=version_no+1 WHERE tenant_id=? AND instance_id=? AND status='pending'`, [actor.teamId, task.instance_id]);
        await connection.query(`UPDATE approval_instances SET status='rejected',current_node_ids_json=JSON_ARRAY(),completed_at=NOW(3),updated_at=NOW(3),version_no=version_no+1 WHERE tenant_id=? AND id=?`, [actor.teamId, task.instance_id]);
      } else {
        const [pendingResult] = await connection.query(`SELECT COUNT(*) AS total FROM approval_tasks WHERE tenant_id=? AND instance_id=? AND node_id=? AND status='pending'`, [actor.teamId, task.instance_id, task.node_id]);
        const pending = Number(one<{ total: number }>(pendingResult)?.total || 0);
        const nodeDone = ["single", "any"].includes(String(task.approval_mode)) || pending === 0;
        if (nodeDone) {
          if (["single", "any"].includes(String(task.approval_mode))) await connection.query(`UPDATE approval_tasks SET status='cancelled',version_no=version_no+1 WHERE tenant_id=? AND instance_id=? AND node_id=? AND status='pending'`, [actor.teamId, task.instance_id, task.node_id]);
          const [versionResult] = await connection.query(`SELECT snapshot_json FROM approval_workflow_versions WHERE tenant_id=? AND id=? LIMIT 1`, [actor.teamId, task.workflow_version_id]);
          const snapshot = parsed<Record<string, unknown>>(one<Record<string, unknown>>(versionResult)?.snapshot_json, {});
          const graph = normalizeApprovalGraph({ nodes: snapshot.nodes, edges: snapshot.edges });
          const context = {
            ...parsed<Record<string, unknown>>(task.business_snapshot_json, {}),
            ...parsed<Record<string, unknown>>(task.form_data_json, {}),
            business: { type: task.business_type, id: task.business_id }
          };
          const graphNext = nextApprovalNodeAfter(graph, String(task.node_id), context);
          const next = graphNext ? {
            id: graphNext.id, name: graphNext.name, approver_strategy: graphNext.approverStrategy,
            approver_config_json: graphNext.approverConfig, approval_mode: graphNext.approvalMode
          } as Record<string, unknown> : null;
          if (next) {
            const approvers = await resolveApprovers(connection, actor, next, String(task.applicant_membership_id || ""));
            for (const assignee of approvers) await connection.query(`INSERT INTO approval_tasks
              (id,tenant_id,instance_id,node_id,assignee_membership_id,status,version_no,created_at) VALUES (?,?,?,?,?,'pending',1,NOW(3))`,
              [id("aptask"), actor.teamId, task.instance_id, next.id, assignee]);
            await connection.query(`UPDATE approval_instances SET current_node_ids_json=?,updated_at=NOW(3),version_no=version_no+1 WHERE tenant_id=? AND id=?`, [json([next.id]), actor.teamId, task.instance_id]);
          } else {
            await connection.query(`UPDATE approval_instances SET status='approved',current_node_ids_json=JSON_ARRAY(),completed_at=NOW(3),updated_at=NOW(3),version_no=version_no+1 WHERE tenant_id=? AND id=?`, [actor.teamId, task.instance_id]);
            await connection.query(`INSERT IGNORE INTO approval_outbox_events
              (id,tenant_id,instance_id,event_type,aggregate_type,aggregate_id,payload_json,status,available_at,created_at)
              VALUES (?,?,?,'approval.completed',?,?,?,'pending',NOW(3),NOW(3))`,
              [id("apout"), actor.teamId, task.instance_id, task.business_type, task.business_id, json({ decision: "approved" })]);
          }
        }
      }
      await connection.commit();
      return { ok: true, instance: publicInstance((await instanceRows(actor, "AND i.id=?", [task.instance_id]))[0] || {}) };
    } catch (error) {
      await connection.rollback();
      if ((error as { code?: string }).code === "ER_DUP_ENTRY") fail(409, "该操作已提交，请勿重复点击", "APPROVAL_DUPLICATE_ACTION");
      throw error;
    } finally { connection.release(); }
  }

  return {
    async listWorkflows(actor) {
      const [result] = await pool.query(`SELECT id FROM approval_workflow_definitions WHERE tenant_id=? ORDER BY updated_at DESC`, [actor.teamId]);
      return { workflows: await Promise.all(rows<{ id: string }>(result).map((item) => workflowDetail(actor, item.id))) };
    },
    async getWorkflow(actor, workflowId) { return { workflow: await workflowDetail(actor, workflowId) }; },
    async createWorkflow(actor, input) {
      const code = text(input.code, 80, true).toLowerCase().replace(/[^a-z0-9_-]/gu, "_");
      const name = text(input.name, 160, true);
      const businessType = text(input.businessType, 60, true);
      const graph = workflowGraph(input);
      const definitionId = id("apwf"); const versionId = id("apver");
      const member = await membership(pool, actor);
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.query(`INSERT INTO approval_workflow_definitions
          (id,tenant_id,code,name,business_type,status,current_version_id,draft_version_id,allow_parallel,priority,is_default,created_by,updated_by,created_at,updated_at)
          VALUES (?,?,?,?,?,'draft',NULL,?,?,?,?,?,?,NOW(3),NOW(3))`, [definitionId, actor.teamId, code, name, businessType, versionId, Boolean(input.allowParallel), Number(input.priority || 100), Boolean(input.isDefault), member.id, member.id]);
        await connection.query(`INSERT INTO approval_workflow_versions
          (id,tenant_id,definition_id,version_no,trigger_config_json,form_schema_json,snapshot_json,status,created_at)
          VALUES (?,?,?,1,?,?,?,'draft',NOW(3))`, [versionId, actor.teamId, definitionId, json(input.triggerConfig || {}), json(input.formSchema || {}), json(graphSnapshot(input, graph))]);
        for (const node of graph.nodes) await connection.query(`INSERT INTO approval_nodes
          (id,tenant_id,workflow_version_id,node_type,name,approver_strategy,approver_config_json,approval_mode,timeout_config_json,sort_order)
          VALUES (?,?,?,?,?,?,?,?,JSON_OBJECT(),?)`, [node.id, actor.teamId, versionId, node.type, node.name, node.approverStrategy, json(node.approverConfig), node.approvalMode, node.sortOrder]);
        await connection.commit();
      } catch (error) { await connection.rollback(); if ((error as { code?: string }).code === "ER_DUP_ENTRY") fail(409, "流程编码已存在"); throw error; }
      finally { connection.release(); }
      return { workflow: await workflowDetail(actor, definitionId) };
    },
    async updateWorkflow(actor, workflowId, input) {
      const graph = workflowGraph(input);
      const member = await membership(pool, actor);
      const [definitionResult] = await pool.query(`SELECT * FROM approval_workflow_definitions WHERE tenant_id=? AND id=? LIMIT 1`, [actor.teamId, workflowId]);
      const definition = one<Record<string, unknown>>(definitionResult) || fail(404, "审批流程不存在");
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        let versionId = String(definition.draft_version_id || "");
        let versionNo = 1;
        if (versionId) {
          const [versionResult] = await connection.query(`SELECT version_no FROM approval_workflow_versions WHERE tenant_id=? AND id=? AND status='draft' LIMIT 1`, [actor.teamId, versionId]);
          versionNo = Number(one<{ version_no: number }>(versionResult)?.version_no || 1);
          await connection.query(`DELETE FROM approval_nodes WHERE tenant_id=? AND workflow_version_id=?`, [actor.teamId, versionId]);
        } else {
          const [latestResult] = await connection.query(`SELECT COALESCE(MAX(version_no),0) AS latest FROM approval_workflow_versions WHERE tenant_id=? AND definition_id=?`, [actor.teamId, workflowId]);
          versionNo = Number(one<{ latest: number }>(latestResult)?.latest || 0) + 1;
          versionId = id("apver");
          await connection.query(`INSERT INTO approval_workflow_versions
            (id,tenant_id,definition_id,version_no,trigger_config_json,form_schema_json,snapshot_json,status,created_at)
            VALUES (?,?,?,?,?,?,?,'draft',NOW(3))`, [versionId, actor.teamId, workflowId, versionNo, json(input.triggerConfig || {}), json(input.formSchema || {}), json(graphSnapshot(input, graph))]);
        }
        if (definition.draft_version_id) {
          await connection.query(`UPDATE approval_workflow_versions SET trigger_config_json=?,form_schema_json=?,snapshot_json=? WHERE tenant_id=? AND id=? AND status='draft'`,
            [json(input.triggerConfig || {}), json(input.formSchema || {}), json(graphSnapshot(input, graph)), actor.teamId, versionId]);
        }
        for (const node of graph.nodes) await connection.query(`INSERT INTO approval_nodes
          (id,tenant_id,workflow_version_id,node_type,name,approver_strategy,approver_config_json,approval_mode,timeout_config_json,sort_order)
          VALUES (?,?,?,?,?,?,?,?,JSON_OBJECT(),?)`, [node.id, actor.teamId, versionId, node.type, node.name, node.approverStrategy, json(node.approverConfig), node.approvalMode, node.sortOrder]);
        await connection.query(`UPDATE approval_workflow_definitions SET name=?,business_type=?,draft_version_id=?,allow_parallel=?,priority=?,is_default=?,updated_by=?,updated_at=NOW(3) WHERE tenant_id=? AND id=?`,
          [text(input.name, 160, true), text(input.businessType, 60, true), versionId, Boolean(input.allowParallel), Number(input.priority || 100), Boolean(input.isDefault), member.id, actor.teamId, workflowId]);
        if (Boolean(input.isDefault)) await connection.query(`UPDATE approval_workflow_definitions SET is_default=FALSE WHERE tenant_id=? AND business_type=? AND id<>?`, [actor.teamId, text(input.businessType, 60, true), workflowId]);
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
      return { workflow: await workflowDetail(actor, workflowId) };
    },
    async resolveWorkflow(actor, input) {
      const businessType = text(input.businessType, 60, true);
      const context = input.context && typeof input.context === "object" ? input.context as Record<string, unknown> : {};
      const [result] = await pool.query(`SELECT d.*,v.version_no,v.trigger_config_json,v.form_schema_json,v.snapshot_json
        FROM approval_workflow_definitions d JOIN approval_workflow_versions v ON v.id=d.current_version_id
        WHERE d.tenant_id=? AND d.business_type=? AND d.status='active'
        ORDER BY d.priority ASC,d.is_default DESC,d.updated_at DESC`, [actor.teamId, businessType]);
      const candidates = rows<Record<string, unknown>>(result).map(publicWorkflow);
      const workflow = candidates.filter((candidate) => !candidate.isDefault).find((candidate) => workflowMatches((candidate.triggerConfig || {}) as Record<string, unknown>, context))
        || candidates.filter((candidate) => candidate.isDefault).find((candidate) => workflowMatches((candidate.triggerConfig || {}) as Record<string, unknown>, context)) || null;
      return { matched: Boolean(workflow), workflow };
    },
    async validateWorkflow(actor, workflowId) {
      const detail = (await workflowDetail(actor, workflowId)) as Record<string, unknown>;
      const graph = normalizeApprovalGraph({ nodes: detail.nodes, edges: detail.edges });
      const issues = validateApprovalGraph(graph);
      return { valid: issues.length === 0, issues, workflow: detail };
    },
    async publishWorkflow(actor, workflowId) {
      const member = await membership(pool, actor);
      const detail = await workflowDetail(actor, workflowId) as Record<string, unknown>;
      const issues = validateApprovalGraph(normalizeApprovalGraph({ nodes: detail.nodes, edges: detail.edges }));
      if (issues.length) fail(409, `流程校验未通过：${issues[0]}`, "APPROVAL_WORKFLOW_INVALID");
      const [versionResult] = await pool.query(`SELECT d.draft_version_id AS id FROM approval_workflow_definitions d WHERE d.tenant_id=? AND d.id=? LIMIT 1`, [actor.teamId, workflowId]);
      const version = one<{ id: string }>(versionResult) || fail(404, "审批流程不存在");
      if (!version.id) fail(409, "当前没有待发布的草稿版本");
      await pool.query(`UPDATE approval_workflow_versions SET status='published',published_by=?,published_at=NOW(3) WHERE tenant_id=? AND id=?`, [member.id, actor.teamId, version.id]);
      await pool.query(`UPDATE approval_workflow_definitions SET status='active',current_version_id=?,draft_version_id=NULL,updated_by=?,updated_at=NOW(3) WHERE tenant_id=? AND id=?`, [version.id, member.id, actor.teamId, workflowId]);
      return { workflow: await workflowDetail(actor, workflowId) };
    },
    async listInstances(actor, status) {
      const values = status ? [status] : [];
      return { instances: (await instanceRows(actor, status ? "AND i.status=?" : "", values)).map(publicInstance) };
    },
    async getInstance(actor, instanceId) {
      const instance = (await instanceRows(actor, "AND i.id=?", [instanceId]))[0] || fail(404, "审批实例不存在");
      const [taskResult, actionResult] = await Promise.all([
        pool.query(`SELECT t.*, n.name AS node_name, u.name AS assignee_name FROM approval_tasks t JOIN approval_nodes n ON n.id=t.node_id JOIN tenant_memberships tm ON tm.id=t.assignee_membership_id AND tm.tenant_id=t.tenant_id JOIN users u ON u.id=tm.user_id WHERE t.tenant_id=? AND t.instance_id=? ORDER BY n.sort_order,t.created_at`, [actor.teamId, instanceId]),
        pool.query(`SELECT a.*, u.name AS actor_name FROM approval_actions a JOIN tenant_memberships tm ON tm.id=a.actor_membership_id AND tm.tenant_id=a.tenant_id JOIN users u ON u.id=tm.user_id WHERE a.tenant_id=? AND a.instance_id=? ORDER BY a.created_at`, [actor.teamId, instanceId])
      ]);
      return { instance: publicInstance(instance), tasks: taskResult[0], actions: actionResult[0] };
    },
    async createInstance(actor, input) {
      const member = await membership(pool, actor);
      let workflowId = text(input.workflowId, 90);
      const key = text(input.idempotencyKey, 160, true);
      if (!workflowId) {
        const resolved = await this.resolveWorkflow(actor, {
          businessType: input.businessType,
          context: { ...(input.businessSnapshot as Record<string, unknown> || {}), ...(input.formData as Record<string, unknown> || {}) }
        }) as { workflow?: Record<string, unknown> | null };
        workflowId = text(resolved.workflow?.id, 90, true);
      }
      const [workflowResult] = await pool.query(`SELECT * FROM approval_workflow_definitions WHERE tenant_id=? AND id=? AND status='active' LIMIT 1`, [actor.teamId, workflowId]);
      const workflow = one<Record<string, unknown>>(workflowResult) || fail(404, "审批流程未发布或不存在");
      const [versionResult] = await pool.query(`SELECT snapshot_json FROM approval_workflow_versions WHERE tenant_id=? AND id=? LIMIT 1`, [actor.teamId, workflow.current_version_id]);
      const snapshot = parsed<Record<string, unknown>>(one<Record<string, unknown>>(versionResult)?.snapshot_json, {});
      const graph = normalizeApprovalGraph({ nodes: snapshot.nodes, edges: snapshot.edges });
      const start = graphStartNode(graph) || fail(409, "审批流程缺少开始节点");
      const context = { ...(input.businessSnapshot as Record<string, unknown> || {}), ...(input.formData as Record<string, unknown> || {}), business: { type: workflow.business_type, id: input.businessId } };
      const graphFirst = nextApprovalNodeAfter(graph, start.id, context);
      const firstNode = graphFirst ? {
        id: graphFirst.id, name: graphFirst.name, approver_strategy: graphFirst.approverStrategy,
        approver_config_json: graphFirst.approverConfig, approval_mode: graphFirst.approvalMode
      } as Record<string, unknown> : fail(409, "审批流程没有可执行的审批节点");
      const approvers = await resolveApprovers(pool, actor, firstNode, member.id);
      const instanceId = id("apins");
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.query(`INSERT INTO approval_instances
          (id,tenant_id,workflow_definition_id,workflow_version_id,business_type,business_id,applicant_membership_id,applicant_org_unit_id,title,summary,form_data_json,business_snapshot_json,status,current_node_ids_json,idempotency_key,version_no,submitted_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'running',?,?,1,NOW(3),NOW(3))`,
          [instanceId, actor.teamId, workflow.id, workflow.current_version_id, workflow.business_type, text(input.businessId, 120), member.id, member.primary_org_unit_id, text(input.title, 220, true), text(input.summary, 500), json(input.formData || {}), json(input.businessSnapshot || {}), json([firstNode.id]), key]);
        for (const assignee of approvers) await connection.query(`INSERT INTO approval_tasks
          (id,tenant_id,instance_id,node_id,assignee_membership_id,status,version_no,created_at) VALUES (?,?,?,?,?,'pending',1,NOW(3))`,
          [id("aptask"), actor.teamId, instanceId, firstNode.id, assignee]);
        await connection.query(`INSERT INTO approval_actions
          (id,tenant_id,instance_id,task_id,action_type,actor_membership_id,comment_text,idempotency_key,metadata_json,created_at)
          VALUES (?,?,?,NULL,'submit',?,?,?,JSON_OBJECT(),NOW(3))`, [id("apact"), actor.teamId, instanceId, member.id, text(input.comment, 1000), key]);
        await connection.commit();
      } catch (error) { await connection.rollback(); if ((error as { code?: string }).code === "ER_DUP_ENTRY") fail(409, "相同审批申请已提交，请勿重复创建"); throw error; }
      finally { connection.release(); }
      return this.getInstance(actor, instanceId);
    },
    async withdrawInstance(actor, instanceId, input) {
      const member = await membership(pool, actor);
      const [result] = await pool.query(`UPDATE approval_instances SET status='withdrawn',completed_at=NOW(3),updated_at=NOW(3),version_no=version_no+1 WHERE tenant_id=? AND id=? AND applicant_membership_id=? AND status='running'`, [actor.teamId, instanceId, member.id]);
      if (!Number((result as { affectedRows?: number }).affectedRows || 0)) fail(409, "当前审批不可撤回");
      await pool.query(`UPDATE approval_tasks SET status='cancelled',version_no=version_no+1 WHERE tenant_id=? AND instance_id=? AND status='pending'`, [actor.teamId, instanceId]);
      await pool.query(`INSERT INTO approval_actions (id,tenant_id,instance_id,task_id,action_type,actor_membership_id,comment_text,idempotency_key,metadata_json,created_at) VALUES (?,?,?,NULL,'withdraw',?,?,?,JSON_OBJECT(),NOW(3))`, [id("apact"), actor.teamId, instanceId, member.id, text(input.comment, 1000), text(input.idempotencyKey, 160, true)]);
      return this.getInstance(actor, instanceId);
    },
    async remindInstance(actor, instanceId, input) {
      const member = await membership(pool, actor);
      const instance = (await instanceRows(actor, "AND i.id=?", [instanceId]))[0] || fail(404, "审批实例不存在");
      if (instance.status !== "running") fail(409, "审批已结束，无需催办");
      await pool.query(`INSERT INTO approval_actions (id,tenant_id,instance_id,task_id,action_type,actor_membership_id,comment_text,idempotency_key,metadata_json,created_at) VALUES (?,?,?,NULL,'remind',?,?,?,JSON_OBJECT(),NOW(3))`, [id("apact"), actor.teamId, instanceId, member.id, text(input.comment, 1000), text(input.idempotencyKey, 160, true)]);
      return { ok: true };
    },
    async listTasks(actor, status) {
      const member = await membership(pool, actor);
      const [result] = await pool.query(`SELECT t.*,n.name AS node_name,i.title,i.summary,i.business_type,i.business_id,i.submitted_at,u.name AS applicant_name
        FROM approval_tasks t JOIN approval_nodes n ON n.id=t.node_id JOIN approval_instances i ON i.id=t.instance_id
        JOIN tenant_memberships am ON am.id=i.applicant_membership_id AND am.tenant_id=i.tenant_id JOIN users u ON u.id=am.user_id
        WHERE t.tenant_id=? AND t.assignee_membership_id=? ${status ? "AND t.status=?" : ""} ORDER BY t.created_at DESC LIMIT 300`, [actor.teamId, member.id, ...(status ? [status] : [])]);
      return { tasks: result };
    },
    async decideTask(actor, taskId, decision, input) { return actionTransaction(actor, taskId, decision, input); },
    async transferTask(actor, taskId, input) {
      const member = await membership(pool, actor); const target = text(input.membershipId, 90, true);
      const [targetResult] = await pool.query(`SELECT id FROM tenant_memberships WHERE tenant_id=? AND id=? AND status='active'`, [actor.teamId, target]);
      if (!one(targetResult)) fail(400, "接收人不是当前公司的有效成员");
      const [result] = await pool.query(`UPDATE approval_tasks SET assignee_membership_id=?,delegated_from=?,version_no=version_no+1 WHERE tenant_id=? AND id=? AND assignee_membership_id=? AND status='pending'`, [target, member.id, actor.teamId, taskId, member.id]);
      if (!Number((result as { affectedRows?: number }).affectedRows || 0)) fail(409, "任务状态已变化，请刷新后重试");
      return { ok: true };
    },
    async addApprover(actor, taskId, input) {
      const member = await membership(pool, actor); const target = text(input.membershipId, 90, true);
      const [taskResult] = await pool.query(`SELECT * FROM approval_tasks WHERE tenant_id=? AND id=? AND assignee_membership_id=? AND status='pending'`, [actor.teamId, taskId, member.id]);
      const task = one<Record<string, unknown>>(taskResult) || fail(409, "任务状态已变化，请刷新后重试");
      await pool.query(`INSERT INTO approval_tasks (id,tenant_id,instance_id,node_id,assignee_membership_id,status,version_no,created_at) VALUES (?,?,?,?,?,'pending',1,NOW(3))`, [id("aptask"), actor.teamId, task.instance_id, task.node_id, target]);
      return { ok: true };
    },
    async commentTask(actor, taskId, input) {
      const member = await membership(pool, actor);
      const [taskResult] = await pool.query(`SELECT instance_id FROM approval_tasks WHERE tenant_id=? AND id=?`, [actor.teamId, taskId]);
      const task = one<{ instance_id: string }>(taskResult) || fail(404, "审批任务不存在");
      await pool.query(`INSERT INTO approval_actions (id,tenant_id,instance_id,task_id,action_type,actor_membership_id,comment_text,idempotency_key,metadata_json,created_at) VALUES (?,?,?,?,'comment',?,?,?,JSON_OBJECT(),NOW(3))`, [id("apact"), actor.teamId, task.instance_id, taskId, member.id, text(input.comment, 1000, true), text(input.idempotencyKey, 160, true)]);
      return { ok: true };
    }
  };
}

export function createMemoryApprovalService(): ApprovalService {
  const workflows: Record<string, unknown>[] = [];
  const instances: Record<string, unknown>[] = [];
  const tasks: Record<string, unknown>[] = [];
  const actions: Record<string, unknown>[] = [];
  const owned = (actor: SessionUser, row: Record<string, unknown>) => row.tenantId === actor.teamId;
  const workflowFor = (actor: SessionUser, workflowId: string) => workflows.find((row) => owned(actor, row) && row.id === workflowId) || fail(404, "审批流程不存在");
  const graphFor = (workflow: Record<string, unknown>, published = false) => {
    const source = published && workflow.publishedGraph ? workflow.publishedGraph as Record<string, unknown> : workflow;
    return normalizeApprovalGraph({ nodes: source.nodes, edges: source.edges });
  };
  const addMemoryTask = (actor: SessionUser, instance: Record<string, unknown>, node: Record<string, unknown>) => {
    tasks.unshift({ id: id("aptask"), tenantId: actor.teamId, instanceId: instance.id, nodeId: node.id, node_name: node.name, assigneeId: actor.id, status: "pending", version_no: 1, title: instance.title, summary: instance.summary });
    instance.currentNodeIds = [node.id];
  };
  const service: ApprovalService = {
    async listWorkflows(actor) { return { workflows: workflows.filter((row) => owned(actor, row)) }; },
    async getWorkflow(actor, workflowId) { return { workflow: workflowFor(actor, workflowId) }; },
    async createWorkflow(actor, input) {
      const now = new Date().toISOString();
      const graph = workflowGraph(input);
      const workflow = {
        id: id("apwf"), tenantId: actor.teamId, code: text(input.code, 80, true), name: text(input.name, 160, true),
        businessType: text(input.businessType, 60, true), status: "draft", versionNo: 1, draftVersionId: id("apver"),
        priority: Number(input.priority || 100), isDefault: Boolean(input.isDefault), triggerConfig: input.triggerConfig || {},
        formSchema: input.formSchema || {}, nodes: graph.nodes, edges: graph.edges, versions: [] as unknown[], createdAt: now, updatedAt: now
      };
      workflows.unshift(workflow); return { workflow };
    },
    async updateWorkflow(actor, workflowId, input) {
      const workflow = workflowFor(actor, workflowId);
      const graph = workflowGraph(input);
      if (!workflow.draftVersionId) { workflow.draftVersionId = id("apver"); workflow.versionNo = Number(workflow.versionNo || 1) + 1; }
      Object.assign(workflow, { name: text(input.name, 160, true), businessType: text(input.businessType, 60, true), priority: Number(input.priority || 100), isDefault: Boolean(input.isDefault), triggerConfig: input.triggerConfig || {}, formSchema: input.formSchema || {}, nodes: graph.nodes, edges: graph.edges, updatedAt: new Date().toISOString() });
      if (workflow.isDefault) for (const candidate of workflows) if (candidate !== workflow && owned(actor, candidate) && candidate.businessType === workflow.businessType) candidate.isDefault = false;
      return { workflow };
    },
    async resolveWorkflow(actor, input) {
      const businessType = text(input.businessType, 60, true);
      const context = input.context && typeof input.context === "object" ? input.context as Record<string, unknown> : {};
      const candidates = workflows.filter((row) => owned(actor, row) && row.status === "active" && row.businessType === businessType)
        .sort((a, b) => Number(a.priority || 100) - Number(b.priority || 100));
      const matches = (row: Record<string, unknown>) => workflowMatches((row.publishedTriggerConfig || row.triggerConfig || {}) as Record<string, unknown>, context);
      const workflow = candidates.filter((row) => !row.isDefault).find(matches) || candidates.filter((row) => row.isDefault).find(matches) || null;
      return { matched: Boolean(workflow), workflow };
    },
    async validateWorkflow(actor, workflowId) {
      const workflow = workflowFor(actor, workflowId); const issues = validateApprovalGraph(graphFor(workflow));
      return { valid: issues.length === 0, issues, workflow };
    },
    async publishWorkflow(actor, workflowId) {
      const workflow = workflowFor(actor, workflowId); const issues = validateApprovalGraph(graphFor(workflow));
      if (issues.length) fail(409, `流程校验未通过：${issues[0]}`, "APPROVAL_WORKFLOW_INVALID");
      (workflow.versions as unknown[]).push(JSON.parse(JSON.stringify({ versionNo: workflow.versionNo, nodes: workflow.nodes, edges: workflow.edges })));
      workflow.publishedGraph = JSON.parse(JSON.stringify({ nodes: workflow.nodes, edges: workflow.edges }));
      workflow.publishedTriggerConfig = JSON.parse(JSON.stringify(workflow.triggerConfig || {}));
      workflow.status = "active"; workflow.currentVersionId = workflow.draftVersionId; workflow.draftVersionId = "";
      return { workflow };
    },
    async listInstances(actor, status) { return { instances: instances.filter((row) => owned(actor, row) && (!status || row.status === status)) }; },
    async getInstance(actor, instanceId) { const instance = instances.find((row) => owned(actor, row) && row.id === instanceId) || fail(404, "审批实例不存在"); return { instance, tasks: tasks.filter((row) => row.instanceId === instanceId), actions: actions.filter((row) => row.instanceId === instanceId) }; },
    async createInstance(actor, input) {
      let workflowId = text(input.workflowId, 90);
      if (!workflowId) {
        const resolved = await service.resolveWorkflow(actor, { businessType: input.businessType, context: { ...(input.businessSnapshot as Record<string, unknown> || {}), ...(input.formData as Record<string, unknown> || {}) } }) as { workflow?: Record<string, unknown> | null };
        workflowId = String(resolved.workflow?.id || "");
      }
      const workflow = workflows.find((row) => owned(actor, row) && row.id === workflowId && row.status === "active") || fail(404, "审批流程未发布或不存在");
      const graph = graphFor(workflow, true); const start = graphStartNode(graph) || fail(409, "审批流程缺少开始节点");
      const context = { ...(input.businessSnapshot as Record<string, unknown> || {}), ...(input.formData as Record<string, unknown> || {}) };
      const node = nextApprovalNodeAfter(graph, start.id, context) || fail(409, "审批流程没有可执行的审批节点");
      const now = new Date().toISOString(); const instanceId = id("apins");
      const instance = { id: instanceId, tenantId: actor.teamId, workflowId: workflow.id, workflowName: workflow.name, workflowGraph: JSON.parse(JSON.stringify(graph)), businessType: workflow.businessType, businessId: text(input.businessId, 120), formData: input.formData || {}, businessSnapshot: input.businessSnapshot || {}, title: text(input.title, 220, true), summary: text(input.summary, 500), status: "running", version: 1, applicantName: actor.name, applicantMembershipId: actor.id, currentNodeIds: [] as unknown[], submittedAt: now, updatedAt: now };
      instances.unshift(instance); addMemoryTask(actor, instance, node as unknown as Record<string, unknown>);
      actions.push({ id: id("apact"), tenantId: actor.teamId, instanceId, action_type: "submit", actor_name: actor.name, comment_text: text(input.comment, 1000), created_at: now });
      return service.getInstance(actor, instanceId);
    },
    async withdrawInstance(actor, instanceId) { const instance = instances.find((row) => owned(actor, row) && row.id === instanceId) || fail(404, "审批实例不存在"); instance.status = "withdrawn"; return service.getInstance(actor, instanceId); },
    async remindInstance() { return { ok: true }; },
    async listTasks(actor, status) { return { tasks: tasks.filter((row) => owned(actor, row) && (!status || row.status === status)) }; },
    async decideTask(actor, taskId, decision, input) {
      const task = tasks.find((row) => owned(actor, row) && row.id === taskId) || fail(404, "审批任务不存在");
      if (task.status !== "pending") fail(409, "审批任务状态已变化，请刷新后重试");
      task.status = decision === "approve" ? "approved" : "rejected";
      const instance = instances.find((row) => row.id === task.instanceId)!;
      actions.push({ id: id("apact"), tenantId: actor.teamId, instanceId: instance.id, action_type: decision, actor_name: actor.name, comment_text: text(input.comment, 1000), created_at: new Date().toISOString() });
      if (decision === "reject") instance.status = "rejected";
      else {
        const context = { ...(instance.businessSnapshot as Record<string, unknown> || {}), ...(instance.formData as Record<string, unknown> || {}) };
        const next = nextApprovalNodeAfter(instance.workflowGraph as ApprovalGraph, String(task.nodeId), context);
        if (next) addMemoryTask(actor, instance, next as unknown as Record<string, unknown>);
        else { instance.status = "approved"; instance.currentNodeIds = []; }
      }
      return service.getInstance(actor, String(task.instanceId));
    },
    async transferTask() { return { ok: true }; }, async addApprover() { return { ok: true }; }, async commentTask() { return { ok: true }; }
  };
  return service;
}

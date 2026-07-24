import assert from "node:assert/strict";
import { app } from "./server.js";
import { createOpenApiDocument } from "./swagger.js";
import {
  agentApiOperationContract,
  assertAgentCompletionEvidence,
  assertAgentOperationInput
} from "./agent-api-contracts.js";
import {
  agentApiRequestSchema,
  classifyAgentApiRequest,
  deniedAgentApiReason
} from "./agent-api-policy.js";

const document = createOpenApiDocument(app) as {
  paths?: Record<string, Record<string, {
    requestBody?: { content?: Record<string, { schema?: unknown }> };
  }>>;
};

let total = 0;
let writes = 0;
let registrySchemas = 0;
let openApiSchemas = 0;

for (const [path, operations] of Object.entries(document.paths || {})) {
  if (deniedAgentApiReason(path)) continue;
  for (const method of ["get", "post", "put", "patch", "delete"] as const) {
    const operation = operations[method];
    if (!operation) continue;
    const risk = classifyAgentApiRequest(method, path);
    const schema = operation.requestBody?.content?.["application/json"]?.schema;
    const contract = agentApiOperationContract(method, path, schema, risk === "draft" ? "read" : risk);
    total += 1;
    assert.equal(contract.risk, risk, `${method.toUpperCase()} ${path} 风险分级不一致`);
    assert.equal(contract.path, path, `${method.toUpperCase()} ${path} 契约路径不一致`);
    assert.ok(contract.executable, `${method.toUpperCase()} ${path} 缺少严格 Agent 操作契约`);
    assert.ok(contract.completionEvidence.description, `${method.toUpperCase()} ${path} 缺少完成证据`);
    if (method !== "get") {
      writes += 1;
      assert.ok(contract.requestSchema, `${method.toUpperCase()} ${path} 缺少请求 Schema`);
      assert.notEqual(contract.requestSchema?.additionalProperties, true, `${method.toUpperCase()} ${path} 不能使用宽泛顶层 Schema`);
    }
    if (contract.schemaSource === "registry") registrySchemas += 1;
    if (contract.schemaSource === "openapi") openApiSchemas += 1;
  }
}

const customerCreate = agentApiOperationContract("POST", "/api/customers", undefined, "write");
assert.equal(customerCreate.authorizationPolicy, "direct_user_intent");
assert.doesNotThrow(() => assertAgentOperationInput(customerCreate, { company: "goodjob01" }));
assert.throws(() => assertAgentOperationInput(customerCreate, { company: "goodjob01", fabricatedPhone: "+15551234567" }), /不在接口契约/u);
assert.throws(() => assertAgentOperationInput(customerCreate, {}), /company/u);
assert.doesNotThrow(() => assertAgentCompletionEvidence(customerCreate, { customer: { id: "c_1" } }));
assert.throws(() => assertAgentCompletionEvidence(customerCreate, { customer: { company: "goodjob01" } }), /缺少完成证据/u);

const bulkDelete = agentApiOperationContract("POST", "/api/customers/bulk-delete", undefined, "write");
assert.equal(bulkDelete.authorizationPolicy, "explicit_confirmation");
assert.throws(() => assertAgentOperationInput(bulkDelete, { ids: [] }), /至少需要/u);

const customerUpdate = agentApiOperationContract("PATCH", "/api/customers/{id}", undefined, "write");
assert.equal(customerUpdate.authorizationPolicy, "direct_user_intent");
assert.doesNotThrow(() => assertAgentOperationInput(customerUpdate, { health: 80, grade: "B" }));

const sendEmail = agentApiOperationContract("POST", "/api/development-email/send", undefined, "external");
assert.equal(sendEmail.authorizationPolicy, "frozen_payload_confirmation");

const tuningInspectRisk = classifyAgentApiRequest("POST", "/api/agent/tuning/inspect");
const tuningInspect = agentApiOperationContract("POST", "/api/agent/tuning/inspect", undefined, tuningInspectRisk === "draft" ? "read" : tuningInspectRisk);
assert.equal(tuningInspect.risk, "read");
assert.equal(tuningInspect.authorizationPolicy, "read_only");
assert.doesNotThrow(() => assertAgentOperationInput(tuningInspect, { goal: "推进德国市场，找当地买家", context: { activeView: "lead-finder" } }));
assert.throws(() => assertAgentOperationInput(tuningInspect, { goal: "找买家", context: { accountId: "u_1" } }), /不在接口契约/u);

assert.doesNotThrow(() => agentApiRequestSchema.parse({ method: "POST", path: "/api/prospect-strategies/ps_1/runs", headers: { "Idempotency-Key": "agent-run-123" }, body: {} }));
assert.throws(() => agentApiRequestSchema.parse({ method: "GET", path: "/api/customers", headers: { Authorization: "forged" } }), /Agent 不允许设置请求头/u);

assert.ok(deniedAgentApiReason("/api/accounts"));
assert.ok(deniedAgentApiReason("/api/system/database-import/jobs"));
assert.ok(deniedAgentApiReason("/api/tools/ai-config"));
assert.ok(deniedAgentApiReason("/api/lead-finder/source-config"));
assert.ok(deniedAgentApiReason("/api/whatsapp/binding/web-scan/start"));

console.log(JSON.stringify({
  ok: true,
  contractVersion: customerCreate.version,
  operations: total,
  writes,
  executable: total,
  coveragePercent: 100,
  registrySchemas,
  openApiSchemas,
  broadWritesBlocked: true,
  riskAndAuthorizationEnforced: true,
  completionEvidenceEnforced: true,
  protectedConfigurationExcluded: true
}, null, 2));

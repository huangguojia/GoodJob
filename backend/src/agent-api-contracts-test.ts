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

const meetingNotesRisk = classifyAgentApiRequest("POST", "/api/customers/c1/meeting-notes");
const meetingNotes = agentApiOperationContract("POST", "/api/customers/{id}/meeting-notes", undefined, meetingNotesRisk);
assert.equal(meetingNotesRisk, "external");
assert.equal(meetingNotes.authorizationPolicy, "frozen_payload_confirmation");
assert.doesNotThrow(() => assertAgentOperationInput(meetingNotes, { transcript: "客户确认下周接收样品。" }));
assert.throws(() => assertAgentOperationInput(meetingNotes, { transcript: "已确认", customerId: "forged" }), /不在接口契约/u);

const sendEmail = agentApiOperationContract("POST", "/api/development-email/send", undefined, "external");
assert.equal(sendEmail.authorizationPolicy, "frozen_payload_confirmation");

const productUpsert = agentApiOperationContract("POST", "/api/tools/products", undefined, "write");
assert.doesNotThrow(() => assertAgentOperationInput(productUpsert, { nameZh: "压力表", price: 12.5 }));
assert.throws(() => assertAgentOperationInput(productUpsert, { nameZh: "压力表", ownerId: "forged" }), /不在接口契约/u);

const shipmentUpsert = agentApiOperationContract("POST", "/api/tools/shipments", undefined, "write");
assert.doesNotThrow(() => assertAgentOperationInput(shipmentUpsert, {
  shipmentNo: "SHP-001",
  items: [{ productName: "Pressure gauge", quantity: 2, unit: "pcs" }]
}));
assert.throws(() => assertAgentOperationInput(shipmentUpsert, {
  items: [{ productName: "Pressure gauge", teamId: "forged" }]
}), /不在接口契约/u);

const shipmentOcrRisk = classifyAgentApiRequest("POST", "/api/tools/shipments/ocr");
const shipmentOcr = agentApiOperationContract(
  "POST",
  "/api/tools/shipments/ocr",
  undefined,
  shipmentOcrRisk === "draft" ? "read" : shipmentOcrRisk
);
assert.equal(shipmentOcrRisk, "external");
assert.equal(shipmentOcr.authorizationPolicy, "frozen_payload_confirmation");
assert.doesNotThrow(() => assertAgentOperationInput(shipmentOcr, { image: "aGVsbG8=", mime: "image/png" }));

const parseGoalRisk = classifyAgentApiRequest("POST", "/api/lead-finder/parse-goal");
const parseGoal = agentApiOperationContract(
  "POST",
  "/api/lead-finder/parse-goal",
  undefined,
  parseGoalRisk === "draft" ? "read" : parseGoalRisk
);
assert.equal(parseGoalRisk, "external");
assert.equal(parseGoal.authorizationPolicy, "frozen_payload_confirmation");
assert.doesNotThrow(() => assertAgentOperationInput(parseGoal, { goal: "寻找德国工业仪表经销商" }));

const launchRisk = classifyAgentApiRequest("POST", "/api/lead-finder/launch");
const launch = agentApiOperationContract(
  "POST",
  "/api/lead-finder/launch",
  undefined,
  launchRisk === "draft" ? "read" : launchRisk
);
assert.equal(launchRisk, "external");
assert.equal(launch.authorizationPolicy, "frozen_payload_confirmation");
assert.doesNotThrow(() => assertAgentOperationInput(launch, {
  mode: "standard",
  campaign: {
    name: "German industrial meter distributors",
    snapshot: {
      products: ["industrial meter"],
      markets: ["Germany"],
      sourceProviderIds: ["gleif"]
    }
  },
  strategy: {
    providerPlan: [{
      providerId: "gleif",
      priority: 1,
      pageLimit: 1,
      resultLimit: 20,
      budgetLimit: 0,
      currency: ""
    }]
  }
}));
assert.doesNotThrow(() => assertAgentCompletionEvidence(launch, {
  run: { id: "pr_1" }
}));

const qualificationApproval = agentApiOperationContract(
  "POST",
  "/api/prospect-list/{id}/qualification/contactability/{decisionId}/approve",
  undefined,
  "write"
);
assert.equal(qualificationApproval.authorizationPolicy, "explicit_confirmation");
assert.doesNotThrow(() => assertAgentOperationInput(qualificationApproval, {
  requestId: "qualification-approval-request"
}));
assert.throws(() => assertAgentOperationInput(qualificationApproval, {
  requestId: "qualification-approval-request",
  aiApproved: true
}), /不在接口契约/u);

const identityBootstrapRisk = classifyAgentApiRequest(
  "POST",
  "/api/prospect-list/prospect_1/identity-bootstrap"
);
assert.equal(identityBootstrapRisk, "external");
const identityBootstrap = agentApiOperationContract(
  "POST",
  "/api/prospect-list/{id}/identity-bootstrap",
  undefined,
  identityBootstrapRisk
);
assert.equal(identityBootstrap.authorizationPolicy, "frozen_payload_confirmation");
assert.doesNotThrow(() => assertAgentOperationInput(identityBootstrap, {
  providerId: "gleif",
  registrationNumber: "529900T8BM49AURSDO55",
  requestId: "identity-bootstrap-request"
}));
assert.throws(() => assertAgentOperationInput(identityBootstrap, {
  providerId: "gleif",
  registrationNumber: "529900T8BM49AURSDO55",
  requestId: "identity-bootstrap-request",
  aiGeneratedCompany: "Fabricated Ltd"
}), /不在接口契约/u);

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

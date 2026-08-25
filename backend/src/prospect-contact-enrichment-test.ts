import assert from "node:assert/strict";
import {
  contactChannelsFromText,
  createContactEnrichmentAttempt,
  expireContactEnrichmentAttempt,
  mergeProspectContactEvidence,
  mergeWebsiteProbeCandidateProgress,
  providerContactEvidence,
  recommendProspectContact,
  sourceRecordContactEvidence
} from "./prospect-contact-enrichment.js";
import type { WebsiteOpportunity } from "./types.js";

const now = new Date().toISOString();
const candidate: WebsiteOpportunity = {
  id: "candidate-contact-test",
  company: "Acme Distribution",
  business: "Lighting distributor",
  country: "United States",
  website: "https://acme.example",
  contact: "Sales Desk",
  contactInfo: "sales@acme.example / +1 (415) 555-0123",
  description: "",
  ownerId: "owner-a",
  teamId: "team-a",
  status: "preview",
  createdAt: now,
  source: "public_procurement",
  sourceLabel: "Public Procurement"
};

assert.deepEqual(contactChannelsFromText(candidate.contactInfo), {
  emails: ["sales@acme.example"],
  phones: ["+14155550123"]
});

const sourceContacts = sourceRecordContactEvidence(candidate);
assert.equal(sourceContacts.length, 1);
assert.equal(sourceContacts[0]?.verificationStatus, "source_confirmed");

const providerContacts = providerContactEvidence({
  company: candidate.company,
  contact: "Alex Morgan",
  contactInfo: "sales@acme.example",
  sourceId: "contact_api",
  sourceLabel: "Contact API",
  sourceUrl: "https://provider.example/evidence/1",
  confidence: 94,
  observedAt: now
});
const merged = mergeProspectContactEvidence(sourceContacts, providerContacts);
assert.equal(merged.length, 1, "相同邮箱必须跨来源去重");
assert.equal(merged[0]?.name, "Alex Morgan", "高可信具名联系人应成为推荐主体");
assert.equal(merged[0]?.corroboratedSources?.length, 2, "去重后必须保留交叉来源");
assert.equal(recommendProspectContact(merged)?.channel.value, "sales@acme.example");

const attempt = createContactEnrichmentAttempt({
  candidate: { ...candidate, extractedContacts: [] },
  runId: "run-contact-test",
  providerSources: [
    { id: "contact_api", label: "Contact API", configured: true },
    { id: "optional_api", label: "Optional API", configured: false }
  ],
  includeWebsite: true
});
assert.equal(attempt.sources.length, 4);
assert.equal(attempt.sources.find((item) => item.sourceId === "optional_api")?.outcome, "not_configured");
assert.equal(attempt.sources.find((item) => item.sourceId === "website_probe")?.status, "queued");

const closedLoopCandidate = {
  ...candidate,
  contact: "",
  contactInfo: "",
  source: "ai_search",
  sourceEvidence: [],
  extractedContacts: []
};
const closedLoopAttempt = createContactEnrichmentAttempt({
  candidate: closedLoopCandidate,
  runId: "run-contact-closed-loop",
  providerSources: [],
  includeWebsite: true,
  webSearch: {
    configured: false,
    message: "未配置支持 Web Search 的模型",
    suggestion: "配置模型后重试"
  },
  runner: {
    configured: true,
    message: "等待 Runner"
  },
  deadlineMs: 60_000
});
assert.equal(closedLoopAttempt.sources.find((item) => item.sourceId === "native_web_search")?.outcome, "not_configured");
assert.equal(closedLoopAttempt.sources.find((item) => item.sourceId === "native_web_search")?.suggestion, "配置模型后重试");
closedLoopAttempt.deadlineAt = new Date(Date.now() - 1_000).toISOString();
assert.equal(expireContactEnrichmentAttempt(closedLoopCandidate, closedLoopAttempt), true);
assert.equal(closedLoopAttempt.status, "failed");
assert.equal(closedLoopAttempt.sources.find((item) => item.sourceId === "website_probe")?.outcome, "timed_out");
assert.match(closedLoopAttempt.sources.find((item) => item.sourceId === "codex_runner")?.suggestion || "", /Runner/u);

const runnerSafeCandidate = structuredClone(closedLoopCandidate);
runnerSafeCandidate.contactEnrichmentAttempts = [structuredClone(closedLoopAttempt)];
runnerSafeCandidate.contactEnrichmentAttempts[0]!.sources.find((item) =>
  item.sourceId === "codex_runner"
)!.taskId = "runner-task-current";
runnerSafeCandidate.websiteProbeAttempts = [{
  id: "probe-current",
  candidateId: runnerSafeCandidate.id,
  teamId: runnerSafeCandidate.teamId,
  ownerId: runnerSafeCandidate.ownerId,
  domain: "acme.example",
  sourceUrl: "https://acme.example/",
  purpose: "company_evidence_enrichment",
  accessMode: "controlled_probe",
  policyVersion: "test",
  status: "running",
  outcome: "pending",
  robotsDecision: "allowed",
  httpStatus: 0,
  responseBytes: 0,
  redirected: false,
  evidence: null,
  events: [],
  failureCode: "",
  failureMessage: "",
  startedAt: now,
  completedAt: "",
  createdAt: now
}];
const staleWebsiteCandidate = structuredClone(runnerSafeCandidate);
staleWebsiteCandidate.contactEnrichmentAttempts![0]!.sources.find((item) =>
  item.sourceId === "codex_runner"
)!.taskId = "";
staleWebsiteCandidate.websiteProbeAttempts![0]!.events.push({
  id: "probe-event-completed",
  sequence: 1,
  stage: "completed",
  status: "completed",
  message: "官网验证完成",
  metrics: {},
  createdAt: now
});
staleWebsiteCandidate.websiteProbeAttempts![0]!.status = "completed";
mergeWebsiteProbeCandidateProgress(runnerSafeCandidate, staleWebsiteCandidate);
assert.equal(
  runnerSafeCandidate.contactEnrichmentAttempts[0]!.sources.find((item) => item.sourceId === "codex_runner")?.taskId,
  "runner-task-current",
  "官网异步进度不得覆盖 Runner 最新任务状态"
);
assert.equal(runnerSafeCandidate.websiteProbeAttempts[0]!.status, "completed");

const aiCandidate = {
  ...candidate,
  source: "ai_search",
  sourceLabel: "AI Search",
  sourceEvidence: []
};
assert.equal(
  sourceRecordContactEvidence(aiCandidate).length,
  0,
  "AI 辅助结果不得直接成为联系人事实"
);

console.log("prospect contact enrichment tests passed");

import assert from "node:assert/strict";
import {
  agentSkillToolRefs,
  compileAgentConsultationEnvelope,
  compileAgentSkillEnvelope,
  getAgentSkill,
  listAgentSkills,
  selectAgentSkills
} from "./agent-skills.js";
import { compileAgentGoalSpec } from "./agent-goal.js";

const skills = listAgentSkills();
assert.ok(skills.length >= 5);
assert.ok(getAgentSkill("system-overview")?.instructions.includes("系统定位"));
assert.ok(getAgentSkill("consultation")?.instructions.includes("咨询不是执行任务"));
assert.deepEqual(getAgentSkill("consultation")?.toolRefs, []);

const consultation = compileAgentConsultationEnvelope("商机能干什么", { activeView: "pipeline" });
assert.equal(consultation[0]?.id, "consultation");
assert.ok(consultation.some((item) => item.id === "system-overview"));
assert.ok(consultation.every((item) => item.id !== "consultation" || item.toolRefs.length === 0));

const prospecting = selectAgentSkills("帮我在德国自动搜客并等待清洗结束", {
  activeView: "lead-finder"
});
assert.deepEqual(
  prospecting.map((skill) => skill.id).slice(0, 2),
  ["system-overview", "prospecting"]
);
assert.ok(agentSkillToolRefs("帮我自动搜客").includes("prospect.start_search"));

const semanticProspectingGoal = "帮我推进德国市场，找一批当地买家";
const semanticProspectingSpec = compileAgentGoalSpec(semanticProspectingGoal, { activeView: "lead-finder" });
const semanticProspecting = compileAgentSkillEnvelope(semanticProspectingGoal, {
  activeView: "lead-finder",
  goalSpec: semanticProspectingSpec
});
const semanticProspectingMatch = semanticProspecting.find((skill) => skill.id === "prospecting");
assert.ok(semanticProspectingMatch);
assert.ok((semanticProspectingMatch?.matchScore || 0) >= 16);
assert.ok(semanticProspectingMatch?.matchReasons.some((reason) => reason.includes("目标域")));

const outreach = compileAgentSkillEnvelope("给当前客户写开发信并发送", {
  activeView: "development-email"
});
assert.ok(outreach.some((skill) => skill.id === "outreach"));
assert.ok(outreach.every((skill) => skill.instructions.length > 0));

const tradeDocuments = compileAgentSkillEnvelope("帮我给 Kanto Retail 的需求商机制作一个 PI，并下载", {
  activeView: "pipeline",
  goalSpec: compileAgentGoalSpec("帮我给 Kanto Retail 的需求商机制作一个 PI，并下载")
});
assert.ok(tradeDocuments.some((skill) => skill.id === "trade-documents"));
assert.ok(agentSkillToolRefs("制作 PI 并下载").includes("api.write"));

console.log(JSON.stringify({
  ok: true,
  skills: skills.map((skill) => skill.id),
  prospecting: prospecting.map((skill) => skill.id),
  semanticProspecting: semanticProspecting.map((skill) => skill.id)
}, null, 2));

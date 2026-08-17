import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
assert.equal(getAgentSkill("system-overview")?.sourceType, "builtin");
assert.equal(getAgentSkill("system-overview")?.acquisitionMethod, "系统内置");
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

const fixtureRoot = mkdtempSync(join(tmpdir(), "goodjob-agent-skills-"));
const previousSkillsDirectory = process.env.AGENT_SKILLS_DIR;
try {
  const externalDirectory = join(fixtureRoot, "external-catalog-skill");
  mkdirSync(externalDirectory);
  writeFileSync(join(externalDirectory, "skill.json"), JSON.stringify({
    id: "external-catalog-skill",
    name: "外部目录 Skill",
    version: "2.1.0",
    category: "catalog",
    description: "验证外部 Skill 获取资料的数据契约。",
    status: "active",
    priority: 40,
    sourceType: "download",
    acquisitionMethod: "供应商下载页",
    downloadUrl: "https://downloads.example.com/skill.zip",
    extractionCode: "A7K9",
    installCommand: "goodjob skill install ./skill.zip",
    acquisitionInstructions: "下载后核验发布者，再由管理员离线安装。",
    homepageUrl: "https://example.com/skill",
    author: "Example Vendor",
    license: "Commercial"
  }));
  writeFileSync(join(externalDirectory, "SKILL.md"), "# 外部目录 Skill\n\n仅用于测试目录契约。");

  const unsafeDirectory = join(fixtureRoot, "unsafe-download-skill");
  mkdirSync(unsafeDirectory);
  writeFileSync(join(unsafeDirectory, "skill.json"), JSON.stringify({
    id: "unsafe-download-skill",
    name: "不安全下载 Skill",
    version: "1.0.0",
    category: "catalog",
    description: "HTTP 下载地址必须被拒绝。",
    status: "active",
    sourceType: "download",
    downloadUrl: "http://downloads.example.com/skill.zip"
  }));
  writeFileSync(join(unsafeDirectory, "SKILL.md"), "# 不安全下载 Skill");

  process.env.AGENT_SKILLS_DIR = fixtureRoot;
  const externalSkills = listAgentSkills({ includeInactive: true });
  assert.equal(externalSkills.length, 1);
  assert.equal(externalSkills[0]?.downloadUrl, "https://downloads.example.com/skill.zip");
  assert.equal(externalSkills[0]?.extractionCode, "A7K9");
  assert.equal(externalSkills[0]?.installCommand, "goodjob skill install ./skill.zip");
  assert.equal(externalSkills.some((skill) => skill.id === "unsafe-download-skill"), false);
} finally {
  if (previousSkillsDirectory === undefined) delete process.env.AGENT_SKILLS_DIR;
  else process.env.AGENT_SKILLS_DIR = previousSkillsDirectory;
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  skills: skills.map((skill) => skill.id),
  prospecting: prospecting.map((skill) => skill.id),
  semanticProspecting: semanticProspecting.map((skill) => skill.id)
}, null, 2));

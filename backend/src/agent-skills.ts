import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { goalSpecSearchText, type AgentGoalSpec } from "./agent-goal.js";

const skillManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/u),
  name: z.string().min(1).max(120),
  version: z.string().min(1).max(40),
  category: z.string().min(1).max(60),
  description: z.string().min(1).max(500),
  status: z.enum(["active", "draft", "archived"]),
  priority: z.number().int().min(0).max(1_000).default(50),
  triggers: z.array(z.string().min(1).max(120)).max(50).default([]),
  keywords: z.array(z.string().min(1).max(80)).max(100).default([]),
  modules: z.array(z.string().min(1).max(80)).max(50).default([]),
  toolRefs: z.array(z.string().min(1).max(120)).max(100).default([])
}).strict();

export interface AgentSkill extends z.infer<typeof skillManifestSchema> {
  instructions: string;
  directory: string;
}

function skillsDirectory() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.AGENT_SKILLS_DIR?.trim() || "",
    resolve(process.cwd(), "agent-skills"),
    resolve(process.cwd(), "../agent-skills"),
    resolve(moduleDir, "../../agent-skills")
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0] || "";
}

export function listAgentSkills(options: { includeInactive?: boolean } = {}) {
  const root = skillsDirectory();
  if (!root || !existsSync(root)) return [] as AgentSkill[];
  const skills: AgentSkill[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = resolve(root, entry.name);
    const manifestPath = resolve(directory, "skill.json");
    const instructionsPath = resolve(directory, "SKILL.md");
    if (!existsSync(manifestPath) || !existsSync(instructionsPath)) continue;
    try {
      const manifest = skillManifestSchema.parse(
        JSON.parse(readFileSync(manifestPath, "utf8"))
      );
      if (!options.includeInactive && manifest.status !== "active") continue;
      const instructions = readFileSync(instructionsPath, "utf8").trim();
      if (!instructions) continue;
      skills.push({ ...manifest, instructions, directory: entry.name });
    } catch (error) {
      if (process.env.NODE_ENV !== "test") {
        console.warn(
          `[agent-skills] ignored invalid skill ${entry.name}: `
          + (error instanceof Error ? error.message : String(error))
        );
      }
    }
  }
  return skills.sort((left, right) =>
    right.priority - left.priority || left.name.localeCompare(right.name)
  );
}

export function getAgentSkill(id: string) {
  return listAgentSkills({ includeInactive: true })
    .find((skill) => skill.id === id);
}

function normalized(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function semanticTerms(value: string) {
  const text = normalized(value);
  const terms = new Set(text.match(/[a-z0-9][a-z0-9_.-]+|[\p{Script=Han}]{2,}/gu) || []);
  for (const group of text.match(/[\p{Script=Han}]{2,}/gu) || []) {
    for (let index = 0; index < group.length - 1; index += 1) terms.add(group.slice(index, index + 2));
  }
  return terms;
}

function semanticOverlap(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  const matches = [...left].filter((term) => right.has(term)).length;
  return matches / Math.max(1, Math.min(left.size, right.size));
}

function goalDomainMatchesSkill(skill: AgentSkill, goalSpec?: AgentGoalSpec) {
  if (!goalSpec) return false;
  const aliases: Partial<Record<AgentGoalSpec["primaryDomain"], string[]>> = {
    customers: ["customers", "customer-pool"],
    leads: ["leads"],
    deals: ["pipeline", "deals", "customers"],
    documents: ["documents", "pipeline"],
    prospecting: ["lead-finder", "prospect-list", "prospecting"],
    outreach: ["development-email", "outreach"],
    communication: ["whatsapp", "communication"],
    research: ["ai-research", "customers", "leads"],
    maintenance: ["customers", "maintenance"],
    "sales-training": ["sales-distillation", "sales-training"],
    knowledge: ["knowledge", "agent-skills"]
  };
  const expected = aliases[goalSpec.primaryDomain] || [goalSpec.primaryDomain];
  return expected.some((item) => skill.modules.includes(item) || skill.category === item);
}

export interface AgentSkillMatch {
  skill: AgentSkill;
  score: number;
  reasons: string[];
}

function skillScore(
  skill: AgentSkill,
  goal: string,
  activeView: string,
  goalSpec?: AgentGoalSpec
) {
  const text = normalized(goalSpec ? goalSpecSearchText(goalSpec) : goal);
  const queryTerms = semanticTerms(text);
  const skillTerms = semanticTerms([
    skill.name,
    skill.category,
    skill.description,
    ...skill.triggers,
    ...skill.keywords,
    ...skill.modules
  ].join(" "));
  const reasons: string[] = [];
  let score = skill.priority / 100;
  for (const trigger of skill.triggers) {
    if (text.includes(normalized(trigger))) {
      score += 12;
      reasons.push(`触发语：${trigger}`);
    }
  }
  for (const keyword of skill.keywords) {
    if (text.includes(normalized(keyword))) {
      score += 4;
      reasons.push(`关键词：${keyword}`);
    }
  }
  const overlap = semanticOverlap(queryTerms, skillTerms);
  if (overlap >= 0.08) {
    score += Math.min(10, Math.round(overlap * 24));
    reasons.push(`语义重合：${Math.round(overlap * 100)}%`);
  }
  if (goalDomainMatchesSkill(skill, goalSpec)) {
    score += 16;
    reasons.push(`目标域：${goalSpec?.primaryDomain}`);
  }
  if (activeView && (skill.modules.includes(activeView) || skill.modules.includes("all"))) {
    score += 3;
    reasons.push(`当前页面：${activeView}`);
  }
  return { score, reasons: [...new Set(reasons)].slice(0, 6) };
}

export function rankAgentSkills(
  goal: string,
  context: { activeView?: string; limit?: number; goalSpec?: AgentGoalSpec } = {}
) {
  const skills = listAgentSkills();
  const system = skills.find((skill) => skill.id === "system-overview");
  const limit = Math.max(1, Math.min(4, context.limit || 3));
  const systemMatch: AgentSkillMatch[] = system
    ? [{ skill: system, score: 100, reasons: ["系统基础 Skill"] }]
    : [];
  const matched = skills
    .filter((skill) => skill.id !== "system-overview")
    .map((skill) => ({ skill, ...skillScore(skill, goal, context.activeView || "", context.goalSpec) }))
    .filter((item) => item.score >= 4)
    .sort((left, right) => right.score - left.score || right.skill.priority - left.skill.priority)
    .slice(0, Math.max(0, limit - systemMatch.length));
  return [...systemMatch, ...matched];
}

export function selectAgentSkills(
  goal: string,
  context: { activeView?: string; limit?: number; goalSpec?: AgentGoalSpec } = {}
) {
  return rankAgentSkills(goal, context).map((item) => item.skill);
}

export function compileAgentSkillEnvelope(
  goal: string,
  context: { activeView?: string; limit?: number; goalSpec?: AgentGoalSpec } = {}
) {
  return rankAgentSkills(goal, context).map(({ skill, score, reasons }) => ({
    id: skill.id,
    name: skill.name,
    version: skill.version,
    category: skill.category,
    description: skill.description,
    toolRefs: skill.toolRefs,
    matchScore: Math.round(score),
    matchReasons: reasons,
    instructions: skill.instructions.slice(0, 8_000)
  }));
}

export function compileAgentConsultationEnvelope(
  goal: string,
  context: { activeView?: string; goalSpec?: AgentGoalSpec } = {}
) {
  const consultation = getAgentSkill("consultation");
  const ranked = compileAgentSkillEnvelope(goal, { ...context, limit: 4 });
  const consultationEntry = consultation ? {
    id: consultation.id,
    name: consultation.name,
    version: consultation.version,
    category: consultation.category,
    description: consultation.description,
    toolRefs: consultation.toolRefs,
    matchScore: 100,
    matchReasons: ["咨询意图强制加载"],
    instructions: consultation.instructions.slice(0, 8_000)
  } : undefined;
  return [consultationEntry, ...ranked]
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index)
    .slice(0, 4);
}

export function agentSkillToolRefs(
  goal: string,
  context: { activeView?: string; limit?: number; goalSpec?: AgentGoalSpec } = {}
) {
  return [...new Set(
    selectAgentSkills(goal, context).flatMap((skill) => skill.toolRefs)
  )];
}

export function publicAgentSkill(skill: AgentSkill, detail = false) {
  return {
    id: skill.id,
    name: skill.name,
    version: skill.version,
    category: skill.category,
    description: skill.description,
    status: skill.status,
    priority: skill.priority,
    triggers: skill.triggers,
    keywords: skill.keywords,
    modules: skill.modules,
    toolRefs: skill.toolRefs,
    directory: skill.directory,
    ...(detail ? { instructions: skill.instructions } : {})
  };
}

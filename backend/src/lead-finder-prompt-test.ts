/**
 * 获客提示词回归测试（2026-11-22 重写）。
 *
 * 背景：提示词曾经把 CRM 查重名录（客户 + 线索 + 历史候选）整份塞进 runner 对话，
 * 涨到约 3.5 万字符后被 Runner 的 2 万硬上限整单拒绝，报错还写成「任务内容不能为空」。
 *
 * 结论：查重不需要模型参与 —— 客户库/线索库由 filterExistingCrmOpportunities 过滤，
 * 历史候选池由 persistProviderOpportunities（isSameProviderOpportunity）合并，
 * 两处都是确定性规则。所以名录已从提示词彻底移除。
 *
 * 这个测试用「客户 300 + 线索 300 + 候选 300」的最坏情况，锁四件事：
 *   1. 提示词里绝不能出现任何名录行（公司名 / 邮箱 / 域名 / 小节标题）；
 *   2. 长度必须远低于 Runner 上限（名录不会再随数据量增长）；
 *   3. 必须明确告诉 CLI「去重由下游负责」，否则模型会自己猜着跳过；
 *   4. 目标数量要按 1.6 倍放大，用来抵消重复，且不超过 50。
 */
import assert from "node:assert/strict";
import { getStore } from "./store.js";
import { LOCAL_RUNNER_PROMPT_MAX_CHARS } from "./integrations/local-runner-service.js";
import { lfindPrompt, lfindTargetCount } from "./routes/lead-finder.js";
import type { Customer, Lead, User, WebsiteOpportunity } from "./types.js";

const store = getStore();
const teamId = "lead-finder-prompt-team";
const ownerId = "u_lead_finder_prompt_owner";
const owner: User = {
  id: ownerId,
  name: "Prompt Budget Owner",
  email: "prompt-budget@example.test",
  password: "test-only",
  role: "admin",
  teamId,
  avatar: "PB",
  status: "active",
  authVersion: 1
};
store.users.push(owner);

// 故意用偏长的公司名：真实数据里带行业后缀、地区名，长度并不短
const longName = (kind: string, index: number) =>
  `${kind} International Trading & Industrial Equipment Imp/Exp Co., Ltd. (Thailand Branch) No.${index}`;

for (let index = 0; index < 300; index += 1) {
  store.customers.push({
    id: `cust_prompt_${index}`,
    company: longName("Customer", index),
    country: "Thailand",
    contact: "Purchasing Manager",
    ownerId,
    teamId,
    stage: "active",
    amount: 0,
    health: 80,
    email: `buyer${index}@customer-${index}.example.com`,
    website: `https://www.customer-${index}.example.com`,
    billingAddress: "Bangkok",
    defaultPortDischarge: "Laem Chabang"
  } as unknown as Customer);

  store.leads.push({
    id: `lead_prompt_${index}`,
    company: longName("Lead", index),
    contact: "Owner",
    country: "Thailand",
    email: `owner${index}@lead-${index}.example.com`,
    phone: "",
    wechat: "",
    source: "website",
    intent: "中",
    stage: "new",
    ownerId,
    teamId,
    status: "new",
    sourceUrl: `https://lead-${index}.example.com/contact`
  } as unknown as Lead);

  store.websiteOpportunities.push({
    id: `opp_prompt_${index}`,
    company: longName("Candidate", index),
    business: "Food moisture measurement instruments distribution",
    country: "Thailand",
    website: `https://www.candidate-${index}.example.com`,
    contact: `Sales Director <sales${index}@candidate-${index}.example.com>`,
    contactInfo: `sales${index}@candidate-${index}.example.com`,
    description: "",
    ownerId,
    teamId
  } as unknown as WebsiteOpportunity);
}

const prompt = lfindPrompt({
  goal: "泰国做食品行业的终端，需要用到水分分析仪器的",
  productKeywords: "moisture analyzers, moisture measurement instruments",
  countries: "Thailand",
  industry: "food",
  customerType: "*",
  excludeKeywords: "",
  limit: 10
} as never);

assert.ok(prompt.startsWith("Use $lfind."), "提示词丢了开头的技能指令");

// 1) 名录彻底不在提示词里：库里有 300 / 300 / 300 条，但一条都不许被引用
for (const forbidden of [
  "## customers",
  "## leads",
  "## candidates",
  "Already known CRM records",
  "Customer International Trading",
  "Lead International Trading",
  "Candidate International Trading",
  "customer-0.example.com",
  "lead-0.example.com",
  "candidate-0.example.com"
]) {
  assert.ok(!prompt.includes(forbidden), `提示词仍然引用了查重名录：${forbidden}`);
}

// 2) 长度与库内数据量无关，且远低于 Runner 上限
assert.ok(
  prompt.length < 6_000,
  `获客提示词 ${prompt.length} 字符，说明还在按数据量拼名录（预期 < 6000）`
);
assert.ok(
  prompt.length < LOCAL_RUNNER_PROMPT_MAX_CHARS,
  `获客提示词 ${prompt.length} 字符，仍超过 Runner 上限 ${LOCAL_RUNNER_PROMPT_MAX_CHARS}`
);

// 3) 必须把去重责任明确交给下游，否则模型会自行猜着跳过
assert.match(prompt, /Deduplication is handled downstream by the CRM/, "没有声明去重由后端负责");
assert.match(prompt, /merge or drop the duplicates/, "没有说明后端会合并或丢弃重复项");

// 4) 目标数量放大（limit 10 → 16），上限 50
assert.equal(lfindTargetCount(10), 16, "limit 10 应放大到 16");
assert.equal(lfindTargetCount(12), 20, "limit 12 应放大到 20");
assert.equal(lfindTargetCount(50), 50, "limit 50 不得超过 50");
assert.equal(lfindTargetCount(1), 2, "limit 1 至少放大到 2");
assert.ok(prompt.includes("aim for 16 accepted candidates"), "提示词里的目标数量没有放大");
assert.ok(prompt.includes('"limit": 16'), "搜索请求 JSON 的 limit 没有放大");

console.log(`lead-finder-prompt-test passed (prompt ${prompt.length} chars, cap ${LOCAL_RUNNER_PROMPT_MAX_CHARS})`);

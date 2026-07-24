import assert from "node:assert/strict";
import {
  agentWorkflowDependenciesSatisfied,
  agentWorkflowDependencyFailure,
  collectAgentStepReferences,
  resolveAgentWorkflowInput,
  validateAgentWorkflowGraph
} from "./agent-workflow.js";

const steps = [
  { key: "create_pi", dependsOn: [], status: "done", input: {}, result: { data: { document: { id: "td_1" }, count: 3 } } },
  { key: "export_pi", dependsOn: ["create_pi"], status: "ready", input: { path: "/api/trade-documents/{{step:create_pi:data.document.id}}/export", count: "{{step:create_pi:data.count}}" } }
];
assert.deepEqual(collectAgentStepReferences(steps[1]!.input), ["create_pi"]);
assert.equal(agentWorkflowDependenciesSatisfied(steps[1]!, steps), true);
assert.equal(agentWorkflowDependenciesSatisfied({ ...steps[1]!, dependsOn: ["missing"] }, steps), false);
assert.deepEqual(resolveAgentWorkflowInput(steps[1]!.input, steps), {
  path: "/api/trade-documents/td_1/export",
  count: 3
});
assert.throws(() => resolveAgentWorkflowInput("{{step:create_pi:data.missing}}", steps), /结果路径不存在/u);
assert.throws(() => resolveAgentWorkflowInput("prefix-{{step:create_pi:data.document}}", steps), /嵌入引用必须是标量/u);
assert.throws(() => resolveAgentWorkflowInput("{{step:create_pi:data.__proto__.id}}", steps), /结果路径不存在/u);
assert.equal(agentWorkflowDependencyFailure(
  { key: "export_pi", dependsOn: ["create_pi"], status: "ready", input: {} },
  [{ key: "create_pi", dependsOn: [], status: "failed", input: {} }]
), "create_pi");
assert.throws(() => validateAgentWorkflowGraph([
  { key: "one", dependsOn: ["two"], input: {} },
  { key: "two", dependsOn: ["one"], input: {} }
]), /循环依赖/u);
assert.throws(() => validateAgentWorkflowGraph([
  { key: "one", dependsOn: ["missing"], input: {} }
]), /依赖不存在/u);

console.log(JSON.stringify({ ok: true, typedReferences: true, dependencies: true, cycleBlocked: true }));

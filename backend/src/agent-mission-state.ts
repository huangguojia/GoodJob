export type AgentMissionNode =
  | "terminal"
  | "wait_timer"
  | "apply_steer"
  | "execute"
  | "approval"
  | "evaluate";

interface MissionStateInput {
  status: string;
  stopReason: string;
  steps: Array<{ key?: string; dependsOn?: string[]; status: string }>;
  hasPendingSteer?: boolean;
}

export function resolveAgentMissionNode(run: MissionStateInput): AgentMissionNode {
  if (["paused", "completed", "cancelled"].includes(run.status)) return "terminal";
  if (run.stopReason.startsWith("wait_until:")) return "wait_timer";
  if (run.hasPendingSteer && !run.steps.some((item) => item.status === "running")) return "apply_steer";
  const dependencyReady = (step: MissionStateInput["steps"][number]) => (step.dependsOn || [])
    .every((key) => run.steps.some((candidate) => candidate.key === key && candidate.status === "done"));
  if (run.steps.some((item) => item.status === "running"
    || (["ready", "queued"].includes(item.status) && dependencyReady(item)))) return "execute";
  if (run.steps.some((item) => item.status === "needs_confirmation" && dependencyReady(item))) return "approval";
  return "evaluate";
}

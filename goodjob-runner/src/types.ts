export interface RunnerConfig {
  serverUrl: string;
  runnerId: string;
  token: string;
  displayName: string;
  workspaces: string[];
  createdAt: string;
}

export type RunnerAdapter = "codex" | "workbuddy" | "muse";

export interface RunnerIdentity {
  hostname: string;
  platform: string;
  runnerVersion: string;
  codexVersion: string;
  workbuddyVersion: string;
  /** Muse Code（Meta 的 `muse` CLI）版本；未安装时为空串，能力自动关闭 */
  museVersion: string;
  capabilities: string[];
  workspaces: string[];
}

export interface ClaimedTask {
  id: string;
  runnerId: string;
  adapter: RunnerAdapter;
  prompt: string;
  workspace: string;
  executionMode: "read_only" | "workspace_write";
  timeoutSeconds: number;
  status: string;
}

export interface RunnerClaim {
  task: ClaimedTask;
  leaseToken: string;
}

export interface TaskEventInput {
  eventType: "status" | "progress" | "output" | "warning" | "error";
  message: string;
  payload?: Record<string, unknown>;
}

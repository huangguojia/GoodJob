export type LocalRunnerStatus = "active" | "revoked";
export type LocalRunnerTaskStatus = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export type LocalRunnerExecutionMode = "read_only" | "workspace_write";

export interface LocalRunnerPairing {
  id: string;
  codeHash: string;
  teamId: string;
  ownerId: string;
  createdBy: string;
  deviceName: string;
  expiresAt: string;
  consumedAt: string;
  runnerId: string;
  createdAt: string;
}

export interface LocalRunner {
  id: string;
  teamId: string;
  ownerId: string;
  displayName: string;
  status: LocalRunnerStatus;
  tokenHash: string;
  tokenFingerprint: string;
  hostname: string;
  platform: string;
  runnerVersion: string;
  codexVersion: string;
  capabilities: string[];
  workspaces: string[];
  lastSeenAt: string;
  lastError: string;
  createdAt: string;
  updatedAt: string;
  revokedAt: string;
}

export interface LocalRunnerTask {
  id: string;
  runnerId: string;
  teamId: string;
  ownerId: string;
  createdBy: string;
  adapter: "codex";
  prompt: string;
  workspace: string;
  executionMode: LocalRunnerExecutionMode;
  timeoutSeconds: number;
  status: LocalRunnerTaskStatus;
  attemptCount: number;
  leaseHash: string;
  leaseExpiresAt: string;
  cancelRequestedAt: string;
  resultText: string;
  errorMessage: string;
  outputTruncated: boolean;
  codexThreadId: string;
  createdAt: string;
  queuedAt: string;
  startedAt: string;
  finishedAt: string;
  updatedAt: string;
}

export interface LocalRunnerTaskEvent {
  id: number;
  taskId: string;
  runnerId: string;
  teamId: string;
  ownerId: string;
  eventType: "status" | "progress" | "output" | "warning" | "error";
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface LocalRunnerClaim {
  task: LocalRunnerTask;
  leaseToken: string;
}

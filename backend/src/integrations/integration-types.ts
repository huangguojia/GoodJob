export type ConnectorType = "native_mcp" | "official_api" | "webhook" | "internal";
export type ConnectorTrust = "system" | "certified" | "private" | "quarantined";
export type ConnectorStatus = "draft" | "review" | "active" | "disabled" | "deprecated";
export type ConnectorReviewStatus = "pending" | "approved" | "rejected";
export type ConnectionScope = "personal" | "team" | "platform";
export type ConnectionStatus =
  | "draft"
  | "authorizing"
  | "pending_confirmation"
  | "discovering"
  | "pending_review"
  | "active"
  | "degraded"
  | "reauthorization_required"
  | "paused"
  | "disconnecting"
  | "disconnected"
  | "failed";
export type ToolStatus = "discovered" | "pending_review" | "active" | "quarantined" | "rejected" | "retired";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "consumed" | "cancelled";
export type ToolCallStatus =
  | "created"
  | "awaiting_approval"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "unknown_outcome"
  | "reconciliation_required"
  | "cancelled";
export type IntegrationEventStatus = "received" | "verified" | "queued" | "processing" | "processed" | "ignored" | "dead_letter" | "replayed";
export type AuthTransactionStatus =
  | "created"
  | "authorize_url_ready"
  | "callback_received"
  | "completed"
  | "failed"
  | "expired"
  | "consumed";

export interface ConnectorDefinition {
  id: string;
  code: string;
  version: string;
  type: ConnectorType;
  trust: ConnectorTrust;
  status: ConnectorStatus;
  teamId: string;
  name: string;
  description: string;
  manifestJson: string;
  manifestHash: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationConnectorReview {
  id: string;
  connectorId: string;
  teamId: string;
  status: ConnectorReviewStatus;
  manifestHash: string;
  submittedBy: string;
  reviewedBy: string;
  reviewNote: string;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationConnection {
  id: string;
  connectorId: string;
  teamId: string;
  ownerId: string;
  scope: ConnectionScope;
  scopeId: string;
  status: ConnectionStatus;
  displayName: string;
  webhookPublicId?: string;
  revision: number;
  lastHealthAt: string;
  lastHealthLatencyMs?: number;
  lastErrorCode: string;
  lastErrorMessage: string;
  serverInfoJson: string;
  warningMessage: string;
  createdAt: string;
  updatedAt: string;
  disconnectedAt: string;
}

export interface IntegrationEvent {
  id: string;
  connectionId: string;
  teamId: string;
  externalEventId: string;
  eventType: string;
  status: IntegrationEventStatus;
  payloadHash: string;
  artifactId: string;
  resultArtifactId: string;
  attemptCount: number;
  resultJson: string;
  writebackStatus: "not_applicable" | "pending" | "completed" | "needs_match" | "failed";
  linkedObjectId: string;
  errorCode: string;
  errorMessage: string;
  nextAttemptAt: string;
  receivedAt: string;
  processedAt: string;
  businessWrittenAt: string;
  updatedAt: string;
}

export interface IntegrationAuthTransaction {
  id: string;
  connectionId: string;
  teamId: string;
  ownerId: string;
  status: AuthTransactionStatus;
  stateHash: string;
  nonceHash: string;
  encryptedContext: string;
  redirectUri: string;
  issuer: string;
  resourceUri: string;
  expiresAt: string;
  consumedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ToolSnapshot {
  id: string;
  connectionId: string;
  teamId: string;
  remoteName: string;
  stableAlias: string;
  displayName: string;
  description: string;
  inputSchemaJson: string;
  outputSchemaJson: string;
  schemaHash: string;
  riskLevel: number;
  status: ToolStatus;
  revision: number;
  discoveredAt: string;
  reviewedAt: string;
  reviewedBy: string;
  permissionCode: string;
  reviewJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationApproval {
  id: string;
  teamId: string;
  ownerId: string;
  connectionId: string;
  toolSnapshotId: string;
  callId: string;
  status: ApprovalStatus;
  riskLevel: number;
  frozenInputHash: string;
  singleUseNonceHash: string;
  requestedBy: string;
  decidedBy: string;
  decisionNote: string;
  expiresAt: string;
  decidedAt: string;
  consumedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationToolCall {
  id: string;
  requestId: string;
  teamId: string;
  ownerId: string;
  actorId: string;
  actorAuthVersion: number;
  connectionId: string;
  toolSnapshotId: string;
  approvalId: string;
  status: ToolCallStatus;
  riskLevel: number;
  inputHash: string;
  inputArtifactId: string;
  inputSummaryJson: string;
  outputHash: string;
  resultArtifactId: string;
  outputSummaryJson: string;
  idempotencyKeyHash: string;
  externalReceipt: string;
  evidenceJson: string;
  errorCode: string;
  errorMessage: string;
  attemptCount: number;
  createdAt: string;
  queuedAt: string;
  startedAt: string;
  finishedAt: string;
  updatedAt: string;
}

export interface ToolGrant {
  id: string;
  toolSnapshotId: string;
  connectionId: string;
  teamId: string;
  subjectType: "user" | "role" | "team";
  subjectId: string;
  permissionCode: string;
  status: "active" | "paused" | "revoked";
  constraintsJson: string;
  grantedBy: string;
  expiresAt: string;
  revokedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationCallEvent {
  id: string;
  callId: string;
  teamId: string;
  actorId: string;
  eventType: string;
  fromStatus: string;
  toStatus: string;
  requestId: string;
  inputHash: string;
  outputHash: string;
  summaryJson: string;
  createdAt: string;
}

const connectionTransitions: Record<ConnectionStatus, ReadonlySet<ConnectionStatus>> = {
  draft: new Set(["authorizing"]),
  authorizing: new Set(["pending_confirmation", "failed", "disconnected"]),
  pending_confirmation: new Set(["discovering", "disconnected"]),
  discovering: new Set(["pending_review", "failed"]),
  pending_review: new Set(["active", "paused"]),
  active: new Set(["degraded", "reauthorization_required", "paused", "disconnecting"]),
  degraded: new Set(["active", "reauthorization_required", "disconnecting"]),
  reauthorization_required: new Set(["authorizing", "disconnecting"]),
  paused: new Set(["active", "disconnecting"]),
  disconnecting: new Set(["disconnected"]),
  disconnected: new Set(),
  failed: new Set(["authorizing", "disconnected"])
};

export function isConnectionTransitionAllowed(from: ConnectionStatus, to: ConnectionStatus) {
  return connectionTransitions[from].has(to);
}

export function assertConnectionTransition(from: ConnectionStatus, to: ConnectionStatus) {
  if (!isConnectionTransitionAllowed(from, to)) {
    const error = new Error(`连接状态不能从 ${from} 变更为 ${to}`);
    Object.assign(error, { code: "INTEGRATION_CONNECTION_STATE_CONFLICT", status: 409 });
    throw error;
  }
}

export function assertConnectionScopeInvariant(connection: Pick<IntegrationConnection, "scope" | "scopeId" | "ownerId" | "teamId">) {
  if (!connection.ownerId || !connection.teamId || !connection.scopeId) throw new Error("连接范围字段不能为空");
  if (connection.scope === "personal" && connection.scopeId !== connection.ownerId) {
    throw new Error("个人连接的 scopeId 必须等于 ownerId");
  }
  if (connection.scope === "team" && connection.scopeId !== connection.teamId) {
    throw new Error("团队连接的 scopeId 必须等于 teamId");
  }
  if (connection.scope === "platform" && connection.scopeId !== "platform") {
    throw new Error("平台连接的 scopeId 必须为 platform");
  }
}

export type IntegrationRole = string;
export type ConnectionScope = "personal" | "team" | "platform";

export interface LocalRunner {
  id: string;
  teamId: string;
  ownerId: string;
  displayName: string;
  status: "active" | "revoked";
  online: boolean;
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
  executionMode: "read_only" | "workspace_write";
  timeoutSeconds: number;
  status: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
  attemptCount: number;
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
  eventType: "status" | "progress" | "output" | "warning" | "error";
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface IntegrationCatalogItem {
  id: string;
  code: string;
  name: string;
  version: string;
  type: "native_mcp" | "official_api" | "webhook" | "internal";
  trust: string;
  status: string;
  teamId: string;
  createdBy: string;
  manifestHash: string;
  description: string;
  manifest: {
    stage: string;
    authentication: string;
    approvedHosts: string[];
    credentialFields?: Array<{ key: string; label: string; minLength: number; maxLength: number; help: string }>;
  };
}

export interface IntegrationConnectorReview {
  id: string;
  connectorId: string;
  teamId: string;
  status: "pending" | "approved" | "rejected";
  manifestHash: string;
  submittedBy: string;
  reviewedBy: string;
  reviewNote: string;
  createdAt: string;
  updatedAt: string;
  connector: {
    id: string;
    code: string;
    version: string;
    name: string;
    description: string;
    type: "native_mcp";
    trust: string;
    status: string;
    teamId: string;
    createdBy: string;
    manifestHash: string;
    manifest: {
      schemaVersion: "1.0";
      stage: "available";
      driver: "native_mcp";
      endpoint: string;
      approvedHosts: string[];
      allowedPorts: number[];
      allowInsecureLoopback?: boolean;
      authentication: "none" | "oauth2";
      oauth?: { clientId: string; clientSecretEnv?: string; scopes: string[] };
      maxTools?: number;
    };
  };
}

export interface IntegrationConnection {
  id: string;
  connectorId: string;
  teamId: string;
  ownerId: string;
  scope: ConnectionScope;
  status: string;
  displayName: string;
  lastHealthAt: string;
  lastHealthLatencyMs: number;
  lastErrorMessage: string;
  serverInfoJson: string;
  updatedAt: string;
}

export interface WecomCommandEndpoint {
  id: string;
  connectionId: string;
  callbackPublicId: string;
  teamId: string;
  corpId: string;
  status: "active" | "disabled";
  callbackPath: string;
  callbackUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface WecomMemberBinding {
  id: string;
  connectionId: string;
  teamId: string;
  wecomUserId: string;
  crmUserId: string;
  crmUserName?: string;
  status: "active" | "revoked";
  verifiedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationAccount {
  id: string;
  name: string;
  email: string;
  role: IntegrationRole;
  teamId: string;
  avatar: string;
  status?: "active" | "disabled";
}

export interface IntegrationAuthTransaction {
  id: string;
  connectionId: string;
  status: "created" | "authorize_url_ready" | "callback_received" | "completed" | "failed" | "expired" | "consumed";
  authorizationUrl: string;
  authorizationHost: string;
  requestedScopes: string[];
  issuer: string;
  resourceUri: string;
  expiresAt: string;
}

export interface IntegrationTool {
  id: string;
  connectionId: string;
  remoteName: string;
  stableAlias: string;
  displayName: string;
  description: string;
  inputSchemaJson: string;
  schemaHash: string;
  riskLevel: number;
  status: string;
  permissionCode: string;
  reviewJson: string;
  updatedAt: string;
}

export interface IntegrationDailyUsage {
  usageDate: string;
  teamId: string;
  connectionId: string;
  toolSnapshotId: string;
  callCount: number;
  successCount: number;
  failureCount: number;
  inputBytes: number;
  outputBytes: number;
  estimatedCost: number;
  updatedAt: string;
}

export interface IntegrationCall {
  id: string;
  requestId: string;
  actorId: string;
  connectionId: string;
  toolSnapshotId: string;
  status: string;
  riskLevel: number;
  inputSummaryJson: string;
  outputSummaryJson: string;
  externalReceipt: string;
  errorMessage: string;
  createdAt: string;
  finishedAt: string;
}

export interface IntegrationEvent {
  id: string;
  connectionId: string;
  externalEventId: string;
  eventType: string;
  status: "received" | "verified" | "queued" | "processing" | "processed" | "ignored" | "dead_letter" | "replayed";
  attemptCount: number;
  resultJson: string;
  writebackStatus: "not_applicable" | "pending" | "completed" | "needs_match" | "failed";
  linkedObjectId: string;
  errorCode: string;
  errorMessage: string;
  receivedAt: string;
  processedAt: string;
  businessWrittenAt: string;
  updatedAt: string;
}

export interface IntegrationApproval {
  id: string;
  connectionId: string;
  callId: string;
  status: "pending" | "consumed" | "rejected" | "expired" | "cancelled";
  riskLevel: number;
  requestedBy: string;
  decidedBy: string;
  decisionNote: string;
  expiresAt: string;
  createdAt: string;
  connectionName: string;
  tool: { remoteName: string; displayName: string; stableAlias: string; schemaHash: string };
  inputSummary: Record<string, unknown>;
  frozenInput: Record<string, unknown>;
}

export interface MicrosoftMailMessage {
  id: string;
  subject: string;
  receivedAt: string;
  sender?: { emailAddress?: { address?: string; name?: string } };
  from?: { emailAddress?: { address?: string; name?: string } };
  conversationId: string;
  internetMessageId?: string;
  bodyPreview: string;
  hasAttachments: boolean;
  isRead: boolean;
  crmMatch: {
    status: "matched" | "ambiguous" | "unmatched";
    customer: { customerId: string; company: string; contact: string; score: number; evidence: string[] } | null;
    candidates: Array<{ customerId: string; company: string; contact: string; score: number; evidence: string[] }>;
  };
}

export interface MicrosoftMailSearchResult {
  callId: string;
  status: string;
  messages: MicrosoftMailMessage[];
  page: { offset?: number; pageSize?: number; nextOffset?: number | null };
  source: string;
  observedAt: string;
}

export interface MicrosoftBusinessCallResult {
  call: IntegrationCall;
  approvalRequired: boolean;
  customer: { id: string; company: string };
}

export type WorkspaceMailMessage = MicrosoftMailMessage;
export type WorkspaceMailSearchResult = MicrosoftMailSearchResult;
export type WorkspaceBusinessCallResult = MicrosoftBusinessCallResult;

interface Envelope<T> {
  requestId: string;
  data: T;
}

export type IntegrationRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export function createIntegrationClient(request: IntegrationRequest) {
  const data = async <T>(path: string, init?: RequestInit) => (await request<Envelope<T>>(path, init)).data;
  const raw = async <T>(path: string, init?: RequestInit) => request<T>(path, init);
  return {
    catalog: () => data<IntegrationCatalogItem[]>("/api/integrations/catalog"),
    connectorReviews: (status = "") => data<IntegrationConnectorReview[]>(`/api/integrations/connectors/reviews${status ? `?status=${encodeURIComponent(status)}` : ""}`),
    createPrivateConnector: (input: {
      name: string;
      code: string;
      version: string;
      description: string;
      manifest: IntegrationConnectorReview["connector"]["manifest"];
    }) => data<{ connector: IntegrationCatalogItem; review: IntegrationConnectorReview }>("/api/integrations/connectors/private", {
      method: "POST",
      body: JSON.stringify(input)
    }),
    reviewPrivateConnector: (id: string, decision: "approved" | "rejected", note = "") =>
      data<{ connector: IntegrationCatalogItem; review: IntegrationConnectorReview }>(`/api/integrations/connectors/${encodeURIComponent(id)}/review`, {
        method: "POST",
        body: JSON.stringify({ decision, note })
      }),
    connections: () => data<IntegrationConnection[]>("/api/integrations/connections"),
    localRunners: () => data<LocalRunner[]>("/api/integrations/local-runners"),
    createLocalRunnerPairing: (deviceName: string) => data<{ pairingCode: string; expiresAt: string; command: string }>("/api/integrations/local-runners/pairings", {
      method: "POST", body: JSON.stringify({ deviceName })
    }),
    revokeLocalRunner: (id: string) => data<LocalRunner>(`/api/integrations/local-runners/${encodeURIComponent(id)}/revoke`, {
      method: "POST", body: "{}"
    }),
    localRunnerTasks: (runnerId = "") => data<LocalRunnerTask[]>(`/api/integrations/local-runner-tasks${runnerId ? `?runnerId=${encodeURIComponent(runnerId)}` : ""}`),
    localRunnerTask: (id: string) => data<{ task: LocalRunnerTask; events: LocalRunnerTaskEvent[] }>(`/api/integrations/local-runner-tasks/${encodeURIComponent(id)}`),
    createLocalRunnerTask: (input: { runnerId: string; prompt: string; workspace: string; executionMode: "read_only" | "workspace_write"; timeoutSeconds: number }) =>
      data<LocalRunnerTask>("/api/integrations/local-runner-tasks", { method: "POST", body: JSON.stringify(input) }),
    cancelLocalRunnerTask: (id: string) => data<LocalRunnerTask>(`/api/integrations/local-runner-tasks/${encodeURIComponent(id)}/cancel`, {
      method: "POST", body: "{}"
    }),
    tools: () => data<IntegrationTool[]>("/api/integrations/tools"),
    calls: () => data<IntegrationCall[]>("/api/integrations/calls"),
    usage: (date = "") => data<IntegrationDailyUsage[]>(`/api/integrations/usage${date ? `?date=${encodeURIComponent(date)}` : ""}`),
    events: (status = "") => data<IntegrationEvent[]>(`/api/integrations/events${status ? `?status=${encodeURIComponent(status)}` : ""}`),
    approvals: () => data<IntegrationApproval[]>("/api/integrations/approvals"),
    wecomEndpoints: (teamId = "") => raw<{ endpoints: WecomCommandEndpoint[] }>(`/api/wecom-command/endpoints${teamId ? `?teamId=${encodeURIComponent(teamId)}` : ""}`),
    createWecomEndpoint: (input: { connectionId: string; teamId?: string; corpId: string; callbackToken: string; encodingAesKey: string }) =>
      raw<{ endpoint: WecomCommandEndpoint }>("/api/wecom-command/endpoints", { method: "POST", body: JSON.stringify(input) }),
    disableWecomEndpoint: (id: string) => raw<{ endpoint: WecomCommandEndpoint }>(`/api/wecom-command/endpoints/${encodeURIComponent(id)}/disable`, { method: "POST" }),
    wecomBindings: (teamId = "") => raw<{ bindings: WecomMemberBinding[] }>(`/api/wecom-command/bindings${teamId ? `?teamId=${encodeURIComponent(teamId)}` : ""}`),
    createWecomBinding: (input: { connectionId: string; teamId?: string; wecomUserId: string; crmUserId: string }) =>
      raw<{ binding: WecomMemberBinding }>("/api/wecom-command/bindings", { method: "POST", body: JSON.stringify(input) }),
    revokeWecomBinding: (id: string) => raw<{ ok: boolean; bindingId: string }>(`/api/wecom-command/bindings/${encodeURIComponent(id)}`, { method: "DELETE" }),
    accounts: () => raw<{ accounts: IntegrationAccount[] }>("/api/accounts"),
    createConnection: (input: { connectorId: string; scope: ConnectionScope; displayName: string; credentials?: Record<string, string> }) =>
      data<IntegrationConnection>("/api/integrations/connections", { method: "POST", body: JSON.stringify(input) }),
    startAuthorization: (id: string) => data<IntegrationAuthTransaction>(`/api/integrations/connections/${encodeURIComponent(id)}/auth/start`, { method: "POST" }),
    authTransaction: (id: string) => data<IntegrationAuthTransaction>(`/api/integrations/auth/transactions/${encodeURIComponent(id)}`),
    confirmAuthorization: (id: string, transactionId = "") => data<IntegrationConnection>(`/api/integrations/connections/${encodeURIComponent(id)}/confirm`, {
      method: "POST",
      body: JSON.stringify({ transactionId })
    }),
    reauthorizeConnection: (id: string) => data<IntegrationAuthTransaction>(`/api/integrations/connections/${encodeURIComponent(id)}/reauthorize`, { method: "POST" }),
    replaceApiCredentials: (id: string, credentials: Record<string, string>) => data<IntegrationConnection>(`/api/integrations/connections/${encodeURIComponent(id)}/credentials`, {
      method: "POST", body: JSON.stringify({ credentials })
    }),
    refreshTools: (id: string) => data<IntegrationConnection>(`/api/integrations/connections/${encodeURIComponent(id)}/refresh-tools`, { method: "POST" }),
    pauseConnection: (id: string) => data<IntegrationConnection>(`/api/integrations/connections/${encodeURIComponent(id)}/pause`, { method: "POST" }),
    resumeConnection: (id: string) => data<IntegrationConnection>(`/api/integrations/connections/${encodeURIComponent(id)}/resume`, { method: "POST" }),
    disconnectConnection: (id: string) => data<IntegrationConnection>(`/api/integrations/connections/${encodeURIComponent(id)}/disconnect`, { method: "POST" }),
    approveTool: (id: string, input: {
      stableAlias: string;
      riskLevel: number;
      permissionCode: string;
      fieldAllowlist: string[];
      dailyCallLimit: number;
      allowedDataClasses: Array<"public" | "business" | "personal" | "sensitive">;
      approvalPolicy: "risk_based" | "always";
      completionEvidence: Array<"created_object_id" | "external_receipt_id" | "state_transition" | "read_after_write_match" | "delivery_acceptance" | "file_artifact">;
    }) => data<IntegrationTool>(`/api/integrations/tools/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify(input) }),
    rejectTool: (id: string, note: string) => data<IntegrationTool>(`/api/integrations/tools/${encodeURIComponent(id)}/reject`, {
      method: "POST",
      body: JSON.stringify({ note })
    }),
    testTool: (id: string) => data<IntegrationCall>(`/api/integrations/tools/${encodeURIComponent(id)}/test`, { method: "POST" }),
    approveExecution: (id: string) => data<IntegrationCall>(`/api/integrations/approvals/${encodeURIComponent(id)}/approve`, { method: "POST" }),
    rejectExecution: (id: string, note: string) => data<IntegrationApproval>(`/api/integrations/approvals/${encodeURIComponent(id)}/reject`, {
      method: "POST",
      body: JSON.stringify({ note })
    }),
    reconcileCall: (id: string, input: { outcome: "succeeded" | "failed"; note: string; externalReceipt: string }) =>
      data<IntegrationCall>(`/api/integrations/calls/${encodeURIComponent(id)}/reconcile`, { method: "POST", body: JSON.stringify(input) }),
    replayEvent: (id: string) => data<IntegrationEvent>(`/api/integrations/events/${encodeURIComponent(id)}/replay`, { method: "POST" }),
    linkEventCustomer: (id: string, customerId: string) =>
      data<IntegrationEvent>(`/api/integrations/events/${encodeURIComponent(id)}/link-customer`, {
        method: "POST",
        body: JSON.stringify({ customerId })
      }),
    searchMicrosoftMail: (input: { query?: string; sender?: string; domain?: string; folder?: "inbox" | "sentitems" | "drafts"; pageSize?: number; offset?: number }) => {
      const query = new URLSearchParams(Object.entries(input).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
      return data<MicrosoftMailSearchResult>(`/api/integrations/microsoft/mail/messages?${query.toString()}`);
    },
    microsoftMessage: (messageId: string) => data<Record<string, unknown>>(`/api/integrations/microsoft/mail/messages/${encodeURIComponent(messageId)}`),
    sendMicrosoftMail: (input: {
      customerId: string; to: string[]; cc?: string[]; subject: string; body: string; bodyType?: "text" | "html";
      attachments?: Array<{ name: string; contentType: string; contentBase64: string }>; conversationId?: string; nextFollowAt?: string;
    }) => data<MicrosoftBusinessCallResult>("/api/integrations/microsoft/mail/send", { method: "POST", body: JSON.stringify(input) }),
    microsoftCalendarEvents: (input: { startUtc: string; endUtc: string; timeZone: string; pageSize?: number; offset?: number }) => {
      const query = new URLSearchParams(Object.entries(input).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
      return data<Record<string, unknown>>(`/api/integrations/microsoft/calendar/events?${query.toString()}`);
    },
    microsoftAvailability: (input: { schedules: string[]; startUtc: string; endUtc: string; timeZone: string; intervalMinutes?: number }) =>
      data<Record<string, unknown>>("/api/integrations/microsoft/calendar/availability", { method: "POST", body: JSON.stringify(input) }),
    createMicrosoftEvent: (input: {
      customerId: string; subject: string; startUtc: string; endUtc: string; timeZone: string; attendees: string[];
      body?: string; onlineMeeting?: boolean; location?: string; nextFollowAt?: string;
    }) => data<MicrosoftBusinessCallResult>("/api/integrations/microsoft/calendar/events", { method: "POST", body: JSON.stringify(input) }),
    updateMicrosoftEvent: (eventId: string, input: Record<string, unknown>) =>
      data<MicrosoftBusinessCallResult>(`/api/integrations/microsoft/calendar/events/${encodeURIComponent(eventId)}`, { method: "PATCH", body: JSON.stringify(input) }),
    microsoftBusinessCall: (callId: string) => data<{ call: IntegrationCall; writeback: { status: string; externalObjectId: string; lastError: string } | null }>(`/api/integrations/microsoft/business-calls/${encodeURIComponent(callId)}`),
    searchGoogleMail: (input: { query?: string; sender?: string; domain?: string; folder?: "inbox" | "sentitems" | "drafts"; pageSize?: number; pageToken?: string }) => {
      const query = new URLSearchParams(Object.entries(input).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
      return data<WorkspaceMailSearchResult>(`/api/integrations/google/mail/messages?${query.toString()}`);
    },
    googleMessage: (messageId: string) => data<Record<string, unknown>>(`/api/integrations/google/mail/messages/${encodeURIComponent(messageId)}`),
    sendGoogleMail: (input: {
      customerId: string; to: string[]; cc?: string[]; subject: string; body: string; bodyType?: "text" | "html";
      attachments?: Array<{ name: string; contentType: string; contentBase64: string }>; conversationId?: string; inReplyTo?: string; nextFollowAt?: string;
    }) => data<WorkspaceBusinessCallResult>("/api/integrations/google/mail/send", { method: "POST", body: JSON.stringify(input) }),
    googleCalendarEvents: (input: { startUtc: string; endUtc: string; timeZone: string; pageSize?: number; pageToken?: string }) => {
      const query = new URLSearchParams(Object.entries(input).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
      return data<Record<string, unknown>>(`/api/integrations/google/calendar/events?${query.toString()}`);
    },
    googleAvailability: (input: { schedules: string[]; startUtc: string; endUtc: string; timeZone: string; intervalMinutes?: number }) =>
      data<Record<string, unknown>>("/api/integrations/google/calendar/availability", { method: "POST", body: JSON.stringify(input) }),
    createGoogleEvent: (input: {
      customerId: string; subject: string; startUtc: string; endUtc: string; timeZone: string; attendees: string[];
      body?: string; onlineMeeting?: boolean; location?: string; nextFollowAt?: string;
    }) => data<WorkspaceBusinessCallResult>("/api/integrations/google/calendar/events", { method: "POST", body: JSON.stringify(input) }),
    updateGoogleEvent: (eventId: string, input: Record<string, unknown>) =>
      data<WorkspaceBusinessCallResult>(`/api/integrations/google/calendar/events/${encodeURIComponent(eventId)}`, { method: "PATCH", body: JSON.stringify(input) }),
    googleBusinessCall: (callId: string) => data<{ call: IntegrationCall; writeback: { status: string; externalObjectId: string; lastError: string } | null }>(`/api/integrations/google/business-calls/${encodeURIComponent(callId)}`)
  };
}

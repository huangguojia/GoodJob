import type { RunnerClaim, RunnerIdentity, TaskEventInput } from "./types.js";

interface ClientOptions {
  serverUrl: string;
  token?: string;
}

export class GoodJobRunnerClient {
  constructor(private readonly options: ClientOptions) {}

  private async request<T>(path: string, input: object, authenticated = true): Promise<T> {
    const response = await fetch(`${this.options.serverUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated && this.options.token ? { authorization: `Runner ${this.options.token}` } : {})
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15_000)
    });
    const body = await response.json().catch(() => ({ message: `HTTP ${response.status}` })) as T & { message?: string };
    if (!response.ok) throw new Error(body.message || `CRM 请求失败（HTTP ${response.status}）`);
    return body;
  }

  pair(input: RunnerIdentity & { code: string; displayName: string }) {
    return this.request<{ runner: { id: string; displayName: string }; token: string }>("/api/integrations/runner-agent/pair", input, false);
  }

  async claim() {
    const result = await this.request<{ claim: RunnerClaim | null }>("/api/integrations/runner-agent/claim", {});
    return result.claim;
  }

  heartbeat(identity: Partial<RunnerIdentity> & { lastError?: string; taskId?: string; leaseToken?: string }) {
    return this.request<{ ok: boolean; cancelRequested: boolean }>("/api/integrations/runner-agent/heartbeat", identity);
  }

  event(taskId: string, leaseToken: string, event: TaskEventInput) {
    return this.request<{ ok: boolean }>(`/api/integrations/runner-agent/tasks/${encodeURIComponent(taskId)}/events`, {
      leaseToken, ...event
    });
  }

  events(taskId: string, leaseToken: string, events: TaskEventInput[]) {
    return this.request<{ ok: boolean }>(`/api/integrations/runner-agent/tasks/${encodeURIComponent(taskId)}/events/batch`, {
      leaseToken, events
    });
  }

  complete(taskId: string, leaseToken: string, input: {
    status: "succeeded" | "failed" | "cancelled";
    resultText: string;
    errorMessage: string;
    outputTruncated: boolean;
    codexThreadId: string;
  }) {
    return this.request<{ ok: boolean; status: string }>(`/api/integrations/runner-agent/tasks/${encodeURIComponent(taskId)}/complete`, {
      leaseToken, ...input
    });
  }
}

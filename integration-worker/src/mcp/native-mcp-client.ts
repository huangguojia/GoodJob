import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/client";
import { createValidatedFetch, validateMcpEndpoint, type EndpointPolicy } from "../network-policy.js";
import { normalizeToolList, type DiscoveredToolSnapshot } from "./tool-schema.js";

export interface NativeMcpClientOptions {
  endpoint: string;
  endpointPolicy: EndpointPolicy;
  timeoutMs: number;
  maxResponseBytes: number;
  accessToken?: string;
  tokenFingerprint?: string;
}

export interface NativeMcpDiscoveryResult {
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
  capabilities: Record<string, unknown>;
  tools: DiscoveredToolSnapshot[];
}

export class NativeMcpClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private tools = new Map<string, Tool>();

  constructor(private readonly options: NativeMcpClientOptions) {}

  async connect() {
    if (this.client) return;
    const endpoint = await validateMcpEndpoint(this.options.endpoint, this.options.endpointPolicy);
    const transport = new StreamableHTTPClientTransport(endpoint, {
      fetch: createValidatedFetch(this.options.endpointPolicy),
      authProvider: this.options.accessToken ? { token: async () => this.options.accessToken } : undefined,
      requestInit: { headers: { "user-agent": "GoodJob-Integration-Worker/1.0" } }
    });
    const client = new Client(
      { name: "goodjob-integration-worker", version: "1.0.0" },
      {
        capabilities: {},
        enforceStrictCapabilities: true,
        listMaxPages: 16,
        versionNegotiation: { mode: "auto", probe: { timeoutMs: this.options.timeoutMs, maxRetries: 0 } }
      }
    );
    try {
      await client.connect(transport, { timeout: this.options.timeoutMs, maxTotalTimeout: this.options.timeoutMs });
      this.client = client;
      this.transport = transport;
    } catch (error) {
      await Promise.allSettled([client.close(), transport.close()]);
      throw error;
    }
  }

  async discoverTools(): Promise<NativeMcpDiscoveryResult> {
    await this.connect();
    const result = await this.client!.listTools(undefined, {
      timeout: this.options.timeoutMs,
      maxTotalTimeout: this.options.timeoutMs,
      cacheMode: "refresh"
    });
    const normalized = normalizeToolList(result.tools, 200);
    this.tools = new Map(result.tools.map((tool) => [tool.name, tool]));
    const server = this.client!.getServerVersion();
    return {
      protocolVersion: this.transport?.protocolVersion || "",
      serverName: server?.name || "unknown",
      serverVersion: server?.version || "",
      capabilities: (this.client!.getServerCapabilities() || {}) as Record<string, unknown>,
      tools: normalized
    };
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<CallToolResult> {
    await this.connect();
    const tool = this.tools.get(name);
    if (!tool) throw new Error("INTEGRATION_TOOL_NOT_APPROVED: 调用前必须完成工具发现并使用对应快照");
    const result = await this.client!.callTool(
      { name, arguments: input },
      {
        timeout: this.options.timeoutMs,
        maxTotalTimeout: this.options.timeoutMs,
        toolDefinition: tool
      }
    );
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (bytes > this.options.maxResponseBytes) throw new Error("INTEGRATION_RESULT_TOO_LARGE: MCP 返回结果超过限制");
    return result;
  }

  async close() {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.tools.clear();
    await Promise.allSettled([client?.close(), transport?.close()]);
  }
}

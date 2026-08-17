import {
  assertConnectorDriverContract,
  type ConnectorDriverContract,
  type ConnectorManifest,
  type DriverHealthResult
} from "./connector-manifest.js";

export interface DriverComplianceOptions<TContext, TDiscovery, TResult> {
  driver: ConnectorDriverContract<TContext, TDiscovery, TResult>;
  validManifest: ConnectorManifest;
  invalidManifest: ConnectorManifest;
  context: TContext;
  knownToolName: string;
  knownToolInput: Record<string, unknown>;
  maxTools: number;
  getToolNames(discovery: TDiscovery): string[];
  validateKnownResult(result: TResult): void;
  isUnknownToolDenied(error: unknown): boolean;
}

export interface DriverComplianceReport {
  ok: true;
  driverType: string;
  toolsDiscovered: number;
  manifestValidation: true;
  contextMinimized: true;
  healthEvidence: true;
  knownToolInvoked: true;
  unknownToolDenied: true;
  connectionClosed: true;
}

const forbiddenContextKeys = new Set([
  "actor", "currentuser", "customer", "customerdata", "lead", "opportunity",
  "crmrecord", "user", "userdata"
]);

function fail(message: string): never {
  throw new Error(`CONNECTOR_DRIVER_COMPLIANCE_FAILED: ${message}`);
}

function assertMinimizedContext(value: unknown, path = "context", seen = new Set<object>()): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value as object)) return;
  seen.add(value as object);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertMinimizedContext(item, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenContextKeys.has(key.toLowerCase())) fail(`${path}.${key} 不得携带 CRM 用户或业务对象`);
    assertMinimizedContext(child, `${path}.${key}`, seen);
  }
}

function assertHealthEvidence<TDiscovery>(health: DriverHealthResult<TDiscovery>) {
  if (health.ok !== true) fail("健康检查必须明确返回 ok=true");
  if (!Number.isFinite(health.latencyMs) || health.latencyMs < 0) fail("健康检查必须返回非负 latencyMs");
  if (!health.checkedAt || Number.isNaN(Date.parse(health.checkedAt))) fail("健康检查必须返回有效 checkedAt");
  if (health.discovery === undefined && health.details === undefined) fail("健康检查必须返回 discovery 或 details 证据");
}

export async function runConnectorDriverComplianceSuite<TContext, TDiscovery, TResult>(
  options: DriverComplianceOptions<TContext, TDiscovery, TResult>
): Promise<DriverComplianceReport> {
  assertConnectorDriverContract(options.driver);
  await options.driver.validateConfiguration(options.validManifest);
  let invalidRejected = false;
  try {
    await options.driver.validateConfiguration(options.invalidManifest);
  } catch {
    invalidRejected = true;
  }
  if (!invalidRejected) fail("非法 Manifest 未被拒绝");
  assertMinimizedContext(options.context);

  let toolsDiscovered = 0;
  let knownToolInvoked = false;
  let unknownToolDenied = false;
  let connectionClosed = false;
  try {
    const discovery = await options.driver.discoverTools(options.context);
    const names = options.getToolNames(discovery);
    toolsDiscovered = names.length;
    if (!names.length || names.length > options.maxTools) fail("发现工具数量必须受限且不能为空");
    if (new Set(names).size !== names.length || names.some((name) => !name.trim())) fail("工具名称必须规范且唯一");
    if (!names.includes(options.knownToolName)) fail("测试用已知工具未出现在发现结果中");

    const health = await options.driver.healthCheck(options.context);
    assertHealthEvidence(health);

    const result = await options.driver.invokeTool(options.context, options.knownToolName, options.knownToolInput);
    options.validateKnownResult(result);
    knownToolInvoked = true;
    try {
      await options.driver.invokeTool(options.context, "__goodjob_unknown_tool__", {});
    } catch (error) {
      unknownToolDenied = options.isUnknownToolDenied(error);
    }
    if (!unknownToolDenied) fail("未知工具未被明确拒绝");
  } finally {
    await options.driver.closeConnection(String((options.context as Record<string, unknown>)?.connectionId || "compliance"));
    connectionClosed = true;
  }

  return {
    ok: true,
    driverType: options.driver.type,
    toolsDiscovered,
    manifestValidation: true,
    contextMinimized: true,
    healthEvidence: true,
    knownToolInvoked,
    unknownToolDenied,
    connectionClosed
  };
}

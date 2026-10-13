import jwt from "jsonwebtoken";

/**
 * 插件读 CRM 数据的唯一通道。
 *
 * 为什么是「自签 token」而不是让用户配一个 Key：插件与 CRM 后端**共享同一个 JWT 签名密钥**
 * （`CRM_JWT_SECRET`），也**共用同一个库**。所以插件可以替某个 owner 签一枚短时效 token，
 * 用**那个人的身份**去读 CRM 数据 —— 这也是「按手机号把 WhatsApp 会话关联到 CRM 客户」能成立的原因
 * （`GET /api/customers` 只返回这个人自己的客户，且只有 owner 本人能看到 `whatsapp` 号码字段）。
 *
 * 这段原本长在 `automation-rhythm.ts` 里。抽出来是因为它一旦分叉就很坑：issuer / audience / TTL
 * 三处必须与 CRM 的 `auth.ts` 逐字一致，两处各签一份时表现是「一条通道能用、另一条 401」。
 */
export function crmIdentityToken(secret: string, userId: string): string {
  return jwt.sign({ ver: 1 }, secret, {
    subject: userId,
    issuer: "goodjob-crm",
    audience: "goodjob-crm-web",
    expiresIn: "10m",
    algorithm: "HS256"
  });
}

/** CRM 库里存的是 `+491234567890`；WhatsApp 页面上可能是 `+49 1234 567890` 或 `491234567890`。 */
export function normalizePhone(value: string | null | undefined): string {
  const digits = String(value ?? "").replace(/\D/gu, "");
  return digits ? `+${digits}` : "";
}

/** 调用 CRM 失败。**刻意不细化**原因：调用方只需要知道"这块依据拿不到"，然后降级继续。 */
export class CrmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrmUnavailableError";
  }
}

export interface CrmClientOptions {
  baseUrl: string;
  /** 缺省 = 不能自签，任何请求都直接判不可用（而不是抛一个难懂的错误）。 */
  jwtSecret?: string;
  /** 单次请求上限。CRM 是本机进程，超过这个数基本就是它卡住了 —— 不许拖着回复链路一起等。 */
  timeoutMs?: number;
  /** 回测注入用。 */
  fetchImpl?: typeof fetch;
}

/** 解析后的连接参数。`CrmClient` 与 `ResourceHubClient` 共用同一份，避免两边超时/鉴权行为分叉。 */
export interface CrmTransport {
  baseUrl: string;
  jwtSecret: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

export function resolveCrmTransport(options: CrmClientOptions): CrmTransport {
  return {
    baseUrl: String(options.baseUrl || "").replace(/\/+$/u, ""),
    jwtSecret: options.jwtSecret?.trim() ?? "",
    timeoutMs: Math.max(500, options.timeoutMs ?? 6_000),
    // 包一层而不是直接存引用：以方法形式调用 globalThis.fetch 时，某些实现会因 this 不对而抛错。
    fetchImpl: options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  };
}

export function crmTransportUnavailableReason(transport: CrmTransport): string {
  if (!transport.jwtSecret) return "CRM 签名密钥未配置（CRM_JWT_SECRET）";
  if (!transport.baseUrl) return "CRM 地址未配置（CRM_BASE_URL）";
  return "";
}

/**
 * 唯一的 CRM HTTP 出口（GET/POST）。自签 token 的签发口径只在这里一处。
 *
 * 注意：`CrmClient` 对外仍然**只有 getJson** —— 插件对 CRM 的写操作（待办、站内信）走的是
 * `automation-rhythm.ts` 那条既有链路。这个函数之所以支持 POST，是因为资源中心的
 * recommend / reveal / feedback 三个接口本身是按 POST 设计的（长对话载荷 + 有副作用并留审计），
 * 它们由 `crm-resources.ts` 单独使用，不改变 `CrmClient` 的公开面。
 */
export async function crmRequestJson<T = unknown>(
  transport: CrmTransport,
  userId: string,
  path: string,
  options: {
    method?: "GET" | "POST";
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    timeoutMs?: number;
  } = {}
): Promise<T> {
  const reason = crmTransportUnavailableReason(transport);
  if (reason) throw new CrmUnavailableError(reason);
  const method = options.method ?? "GET";
  const url = new URL(`${transport.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  const timeout = Math.max(500, options.timeoutMs ?? transport.timeoutMs);
  let response: Response;
  try {
    response = await transport.fetchImpl(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${crmIdentityToken(transport.jwtSecret, userId)}`,
        accept: "application/json",
        ...(method === "POST" ? { "content-type": "application/json" } : {})
      },
      ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
      signal: AbortSignal.timeout(timeout)
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CrmUnavailableError(`CRM 请求失败（${path}）：${detail}`);
  }
  if (!response.ok) throw new CrmUnavailableError(`CRM 返回 HTTP ${response.status}（${path}）`);
  try {
    return (await response.json()) as T;
  } catch {
    throw new CrmUnavailableError(`CRM 返回的不是 JSON（${path}）`);
  }
}

/**
 * 只读的 CRM 客户端。**刻意只有 getJson**：插件对 CRM 的写操作（待办、站内信）走的是
 * `automation-rhythm.ts` 那条既有链路，不要在这里悄悄多开一条。
 */
export class CrmClient {
  private readonly transport: CrmTransport;

  constructor(options: CrmClientOptions) {
    this.transport = resolveCrmTransport(options);
  }

  get configured(): boolean {
    return Boolean(this.transport.baseUrl && this.transport.jwtSecret);
  }

  /** 不可用时说明原因，界面与提示词都用它解释「为什么这次没有 CRM 依据」。 */
  unavailableReason(): string {
    return crmTransportUnavailableReason(this.transport);
  }

  async getJson<T = unknown>(
    userId: string,
    path: string,
    options: { query?: Record<string, string | number | undefined>; timeoutMs?: number } = {}
  ): Promise<T> {
    return crmRequestJson<T>(this.transport, userId, path, { ...options, method: "GET" });
  }
}

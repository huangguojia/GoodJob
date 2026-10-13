import { ProxyAgent, type Dispatcher } from "undici";

/**
 * Meta Cloud API 出网代理。
 *
 * 为什么需要它：在受限网络下（本机只能经本地代理出网），graph.facebook.com 与 Meta 媒体 CDN
 * 直连必然超时，而 Node 内置 fetch **不读 HTTP(S)_PROXY 环境变量**，必须显式挂 dispatcher。
 *
 * 为什么按域名白名单而不是全局挂：插件同时要访问本机 CRM（127.0.0.1:4188）和用户自配的
 * AI 端点（可能是内网地址）。这些请求一旦被兜进代理会直接坏掉，所以只对 Meta 域名走代理，
 * 其余地址保持原样直连。
 */

const META_PROXIED_HOST_SUFFIXES = ["facebook.com", "fbcdn.net", "fbsbx.com", "whatsapp.net"];

let proxyDispatcher: Dispatcher | undefined;

/** 由运行时在启动时调用一次；传空值即关闭代理（默认直连）。 */
export function configureOutboundProxy(proxyUrl: string | undefined): void {
  const candidate = proxyUrl?.trim();
  proxyDispatcher = candidate ? new ProxyAgent(candidate) : undefined;
}

export function isProxiedHost(
  rawUrl: string,
  suffixes: readonly string[] = META_PROXIED_HOST_SUFFIXES
): boolean {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "") return false;
  return suffixes.some((suffix) => {
    const normalized = suffix.trim().toLowerCase().replace(/^\./u, "");
    return normalized !== "" && (hostname === normalized || hostname.endsWith(`.${normalized}`));
  });
}

/**
 * 把结果展开进 fetch 的 init。未配置代理、或目标不是 Meta 域名时返回空对象，
 * 行为与直接 fetch 完全一致。
 */
export function outboundProxyInit(url: string): { dispatcher?: Dispatcher } {
  if (!proxyDispatcher || !isProxiedHost(url)) return {};
  return { dispatcher: proxyDispatcher };
}

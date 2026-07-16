const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export function resolveBackendHost(env: NodeJS.ProcessEnv = process.env) {
  const host = (env.BACKEND_HOST || "127.0.0.1").trim();
  if (!host) throw new Error("BACKEND_HOST 不能为空");
  if (env.NODE_ENV === "production" && !LOOPBACK_HOSTS.has(host)) {
    throw new Error("生产环境后端只能监听回环地址，请使用 127.0.0.1 或 ::1");
  }
  return host;
}

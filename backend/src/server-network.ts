const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const CONTAINER_HOSTS = new Set(["0.0.0.0", "::"]);

export function resolveBackendHost(env: NodeJS.ProcessEnv = process.env) {
  const host = (env.BACKEND_HOST || "127.0.0.1").trim();
  if (!host) throw new Error("BACKEND_HOST 不能为空");
  const containerBindAllowed = env.CONTAINER_NETWORK_BIND === "true"
    && CONTAINER_HOSTS.has(host);
  if (env.NODE_ENV === "production" && !LOOPBACK_HOSTS.has(host) && !containerBindAllowed) {
    throw new Error("生产环境后端只能监听回环地址；容器内监听需显式设置 CONTAINER_NETWORK_BIND=true");
  }
  return host;
}

import { createServer, type RequestListener, type Server } from "node:http";

/**
 * 给回测起一个**持久**的 HTTP 监听，代替 supertest 默认的「每个请求临时 listen(0) + close()」。
 *
 * 为什么需要：supertest 拿到 Express app（函数）时会为**每一个请求**新建一个 server
 * 并监听随机端口，响应回来后立刻 close()。一条用例往往要发好几个请求，一个文件就是上百次
 * 端口绑定/释放，于是内核很快把刚释放的临时端口重新分配给下一个监听者 —— 客户端可能连上
 * 一个正在关闭或已被复用的监听者，表现为随机的 `socket hang up` / `read ECONNRESET`。
 *
 * 实测（8 核 Mac，同一进程、同一 app、各 300 次 POST /api/v1/demo/inbound）：
 *   - 每请求临时监听：2 次失败（`socket hang up`、`read ECONNRESET`）
 *   - 单一持久监听：0 次失败
 *
 * 用法：把 `request(runtime.app)` 换成 `request(server)` 即可；传入已经在监听的 server 时
 * supertest 不会再自己建也**不会**替我们关（它只关自己建的那个 `_server`）。
 */
export const bindPersistentTestServer = async (app: unknown): Promise<Server> => {
  const server = createServer(app as RequestListener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return server;
};

/** 用完必须关掉，否则 vitest 会因残留句柄不退出。 */
export const closePersistentTestServer = async (server: Server | undefined): Promise<void> => {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

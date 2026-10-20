import { app } from "./server.js";

// ---------------------------------------------------------------------------
// 「插件登录一个月」自测（2026-10-20）。
//
// 背景：WhatsApp 扩展 / 本机插件控制台长期挂在浏览器里，它拿的是 CRM 的 Bearer。
// 原来所有登录共用一个 8 小时 TTL，用户每天上班都要重新输一次密码（当天实测撞了两次 401）。
// 现在改成：**只有显式声明 `client: "plugin"` 的登录**发 30 天令牌，网页端仍是 8 小时。
//
// 纪律：断言的是**实际 HTTP 响应**（响应体里的 JWT、Set-Cookie 头、以及这枚令牌能不能用），
//       不是内部函数 —— 否则「路由没接上 client 字段」也会全绿。
// ---------------------------------------------------------------------------

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start auth plugin-token test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(
    `${label}${detail === undefined ? "" : ` → ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`
  );
}

/** JWT 载荷（只解不验：这里断言的是 issuance，验签由 requireAuth 负责）。 */
function claimsOf(token: string): { iat?: number; exp?: number; sub?: string; ver?: number } {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { iat?: number; exp?: number };
  } catch {
    return {};
  }
}

function ttlSeconds(token: string): number {
  const claims = claimsOf(token);
  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp)) return 0;
  return Number(claims.exp) - Number(claims.iat);
}

async function login(body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => ({}))) as { token?: string; user?: { id?: string } };
  return {
    status: response.status,
    token: String(payload.token ?? ""),
    user: payload.user,
    cookies: response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ")
  };
}

const EIGHT_HOURS = 8 * 60 * 60;
const THIRTY_DAYS = 30 * 24 * 60 * 60;

try {
  /* ---------- 1. 网页端登录：仍是 8 小时，且照常下发会话 cookie ---------- */
  const web = await login({ email: "admin@goodjob.com", password: "goodjob123" });
  check("网页端登录成功", web.status === 200 && Boolean(web.token), `${web.status}`);
  check("网页端令牌 TTL = 8 小时", ttlSeconds(web.token) === EIGHT_HOURS, ttlSeconds(web.token));
  check("网页端照常写 gj_session cookie", web.cookies.includes("gj_session="), web.cookies);

  /* ---------- 2. 插件登录：一个月，且不写 cookie ---------- */
  const plugin = await login({ email: "admin@goodjob.com", password: "goodjob123", client: "plugin" });
  check("插件登录成功", plugin.status === 200 && Boolean(plugin.token), `${plugin.status}`);
  check("插件令牌 TTL = 30 天", ttlSeconds(plugin.token) === THIRTY_DAYS, ttlSeconds(plugin.token));
  check("插件令牌仍绑定同一个用户", claimsOf(plugin.token).sub === claimsOf(web.token).sub, {
    plugin: claimsOf(plugin.token).sub,
    web: claimsOf(web.token).sub
  });
  // 不种 cookie 不是省事，是有意的：跨源 cookie 对扩展毫无用处，
  // 种下去只会让「网页登录态」和「插件登录态」共用一个 8 小时的开关。
  check("插件登录不写会话 cookie", !plugin.cookies.includes("gj_session="), plugin.cookies);

  /* ---------- 3. 这枚长令牌真的能用（不是只有 exp 对、验签却过不去） ---------- */
  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { authorization: `Bearer ${plugin.token}` } });
  const meBody = (await me.json().catch(() => ({}))) as { user?: { id?: string } };
  check("插件长令牌能通过 requireAuth", me.status === 200, `${me.status}`);
  check("取回的就是登录者本人", meBody.user?.id === plugin.user?.id, { me: meBody.user?.id, login: plugin.user?.id });

  /* ---------- 4. 显式 web / 未知取值 ---------- */
  const explicitWeb = await login({ email: "admin@goodjob.com", password: "goodjob123", client: "web" });
  check("显式 client=web 仍是 8 小时", ttlSeconds(explicitWeb.token) === EIGHT_HOURS, ttlSeconds(explicitWeb.token));
  const bogus = await login({ email: "admin@goodjob.com", password: "goodjob123", client: "plugin-longer" });
  check("非法 client 取值被拒（不允许客户端自选任意时长）", bogus.status === 400, `${bogus.status}`);

  /* ---------- 5. 密码错时不该因为 client 字段就绕过校验 ---------- */
  const wrong = await login({ email: "admin@goodjob.com", password: "definitely-wrong", client: "plugin" });
  check("插件登录也要验密码", wrong.status === 401 && !wrong.token, `${wrong.status}`);
} finally {
  server.close();
}

console.log(`\n插件令牌自测：通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`);
if (failures.length) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exitCode = 1;
}

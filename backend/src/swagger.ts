import type { Application, NextFunction, Request, Response } from "express";
import swaggerUi from "swagger-ui-express";
import { requireAuth } from "./auth.js";

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

interface ExpressRouteLayer {
  route?: {
    path?: string;
    methods?: Record<string, boolean>;
  };
}

const methodLabels: Record<HttpMethod, string> = {
  get: "查询",
  post: "提交",
  put: "替换",
  patch: "更新",
  delete: "删除"
};

const tagRules = [
  ["/api/auth", "认证"],
  ["/api/profile", "个人设置"],
  ["/api/accounts", "账号管理"],
  ["/api/customers", "客户"],
  ["/api/leads", "线索"],
  ["/api/deals", "商机"],
  ["/api/commission", "提成"],
  ["/api/todos", "待办"],
  ["/api/plan-", "执行计划"],
  ["/api/problems", "问题"],
  ["/api/memos", "备忘"],
  ["/api/competitors", "竞品"],
  ["/api/case-studies", "案例"],
  ["/api/knowledge", "知识库"],
  ["/api/exam", "考试"],
  ["/api/reminders", "提醒"],
  ["/api/import-export", "导入导出"],
  ["/api/trade-documents", "贸易单据"],
  ["/api/whatsapp", "WhatsApp"],
  ["/api/wecom", "企业微信"],
  ["/api/prospect-list", "搜客清单"],
  ["/api/lead-finder", "自动搜客"],
  ["/api/tools", "工具"],
  ["/api/dashboard", "工作台"],
  ["/api/reports", "经营报告"],
  ["/api/health", "系统"]
] as const;

function tagForPath(path: string) {
  return tagRules.find(([prefix]) => path.startsWith(prefix))?.[1] || "其他";
}

function openApiPath(path: string) {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function pathParameters(path: string) {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: { type: "string" }
  }));
}

function operationId(method: HttpMethod, path: string) {
  const suffix = path
    .replace(/^\/api\//, "")
    .replace(/:([A-Za-z0-9_]+)/g, "by-$1")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${method}-${suffix}`;
}

function securityFor(method: HttpMethod, path: string) {
  if (path === "/api/health" || path === "/api/auth/login" || path === "/api/auth/logout") return [];
  if (path === "/api/whatsapp/webhook/twilio") return [{ twilioSignature: [] }];
  if (method === "get") return [{ bearerAuth: [] }, { cookieAuth: [] }];
  return [{ bearerAuth: [] }, { cookieAuth: [], csrfToken: [] }];
}

function requestBodyFor(method: HttpMethod, path: string) {
  if (method === "get" || method === "delete") return undefined;
  const schema = path === "/api/auth/login"
    ? {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email", description: "CRM 登录邮箱" },
          password: { type: "string", format: "password", description: "CRM 登录密码" }
        },
        additionalProperties: false
      }
    : {
        type: "object",
        description: "字段以对应业务页面提交内容为准；服务端会继续执行 Zod 参数校验。",
        additionalProperties: true
      };
  return {
    required: false,
    content: {
      "application/json": { schema }
    }
  };
}

function registeredApiRoutes(app: Application) {
  const stack: ExpressRouteLayer[] = (app as Application & { _router?: { stack?: ExpressRouteLayer[] } })._router?.stack || [];
  return stack.flatMap((layer): Array<{ method: HttpMethod; path: string }> => {
    const path = layer.route?.path;
    if (typeof path !== "string" || !path.startsWith("/api/") || path.startsWith("/api/docs")) return [];
    return Object.entries(layer.route?.methods || {})
      .filter(([, enabled]) => enabled)
      .map(([method]) => method.toLowerCase())
      .filter((method): method is HttpMethod => method in methodLabels)
      .map((method) => ({ method, path }));
  });
}

export function createOpenApiDocument(app: Application) {
  const routes = registeredApiRoutes(app);
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const path = openApiPath(route.path);
    paths[path] ||= {};
    paths[path][route.method] = {
      tags: [tagForPath(route.path)],
      summary: `${methodLabels[route.method]} ${route.path}`,
      operationId: operationId(route.method, route.path),
      security: securityFor(route.method, route.path),
      parameters: pathParameters(route.path),
      requestBody: requestBodyFor(route.method, route.path),
      responses: {
        "200": {
          description: "请求成功",
          content: {
            "application/json": {
              schema: { type: "object", additionalProperties: true }
            }
          }
        },
        "400": { $ref: "#/components/responses/BadRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" }
      }
    };
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "GoodJob CRM API",
      version: "1.0.0",
      description: [
        "部署调试文档，仅管理员和超级管理员可访问。",
        "浏览器调试优先使用现有登录 Cookie；写请求会由 Swagger UI 自动附加 CSRF 请求头。",
        "第三方调试可调用登录接口取得 token，再在 Authorize 中填写 Bearer Token。",
        "接口返回范围仍遵循业务员本人、主管团队、管理员全局的数据隔离规则。"
      ].join("\n\n")
    },
    servers: [{ url: "/", description: "当前部署环境" }],
    tags: [...new Set(routes.map(({ path }) => tagForPath(path)))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "登录接口响应中的 token。Swagger Authorize 中只填写 token，不要添加 Bearer 前缀。"
        },
        cookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: "gj_session",
          description: "CRM 登录后由浏览器自动携带的 HttpOnly 会话 Cookie。"
        },
        csrfToken: {
          type: "apiKey",
          in: "header",
          name: "X-CSRF-Token",
          description: "Cookie 会话执行写操作时需要；Swagger UI 会从 gj_csrf Cookie 自动附加。"
        },
        twilioSignature: {
          type: "apiKey",
          in: "header",
          name: "X-Twilio-Signature",
          description: "Twilio Webhook 签名。"
        }
      },
      schemas: {
        Error: {
          type: "object",
          required: ["message"],
          properties: {
            message: { type: "string" },
            issues: { type: "array", items: { type: "object", additionalProperties: true } }
          }
        }
      },
      responses: {
        BadRequest: {
          description: "参数或 JSON 格式错误",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }
        },
        Unauthorized: {
          description: "未登录或会话已失效",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }
        },
        Forbidden: {
          description: "无操作权限、CSRF 校验失败或来源不受信任",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }
        },
        NotFound: {
          description: "资源不存在或不在当前账号的数据范围内",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }
        }
      }
    }
  };
}

function requireApiDocsAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (req.user?.role !== "admin" && req.user?.role !== "super_admin") {
      res.status(403).json({ message: "只有管理员和超级管理员可以访问 API 调试文档" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });
}

const swaggerOptions = {
  customSiteTitle: "GoodJob CRM API 调试",
  customRobots: "noindex,nofollow",
  customCss: [
    ".swagger-ui .topbar { display: none; }",
    ".swagger-ui .info { margin: 28px 0; }",
    ".swagger-ui .scheme-container { box-shadow: none; border: 1px solid #e3e7ef; }",
    ".swagger-ui .opblock { border-radius: 6px; box-shadow: none; }"
  ].join("\n"),
  swaggerOptions: {
    persistAuthorization: false,
    displayRequestDuration: true,
    filter: true,
    tryItOutEnabled: true,
    validatorUrl: null,
    withCredentials: true,
    requestInterceptor: (request: { method?: string; headers?: Record<string, string>; credentials?: string }) => {
      request.credentials = "same-origin";
      if (!["GET", "HEAD", "OPTIONS"].includes(String(request.method || "").toUpperCase())) {
        const csrfCookie = document.cookie
          .split("; ")
          .find((item) => item.startsWith("gj_csrf="))
          ?.slice("gj_csrf=".length);
        if (csrfCookie) {
          request.headers ||= {};
          request.headers["X-CSRF-Token"] = decodeURIComponent(csrfCookie);
        }
      }
      return request;
    }
  }
};

export function registerSwagger(app: Application) {
  if (process.env.ENABLE_API_DOCS === "false") return;
  const document = createOpenApiDocument(app);
  const uiAssets = swaggerUi.serveFiles(document, swaggerOptions);
  app.get("/api/docs/openapi.json", requireApiDocsAdmin, (_req, res) => {
    res.json(document);
  });
  app.use("/api/docs", requireApiDocsAdmin, uiAssets);
  app.get("/api/docs", requireApiDocsAdmin, swaggerUi.setup(document, swaggerOptions));
}

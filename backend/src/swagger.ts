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
  ["/api/prospects", "候选客户"],
  ["/api/prospect-campaigns", "获客项目"],
  ["/api/prospect-strategies", "获客策略"],
  ["/api/prospect-schedules", "定时获客"],
  ["/api/prospect-runs", "搜索运行"],
  ["/api/prospect-agent-jobs", "智能获客任务"],
  ["/api/organization-identity-conflicts", "企业身份复核"],
  ["/api/organization-relations", "企业主数据"],
  ["/api/organizations", "企业主数据"],
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

function pathParameters(path: string, method: HttpMethod) {
  const parameters: Array<Record<string, unknown>> = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    ...(path === "/api/prospect-campaigns/:id/market-analysis-runs" && match[1] === "id"
      ? {
          description: "正式项目使用服务端生成的 pc_<UUID>；非 pc_ 引用暂按当前登录人 owner-scope 兼容处理。"
        }
      : {}),
    schema: { type: "string" }
  }));
  if (path === "/api/prospect-campaigns/:id/market-analysis-runs") {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      description: "同一登录账号和获客项目兼容引用内的请求幂等键；失败任务在允许时间后使用同一键会真实重跑。",
      schema: {
        type: "string",
        minLength: 8,
        maxLength: 200,
        pattern: "^[A-Za-z0-9._:-]+$"
      }
    });
  }
  if (path === "/api/prospect-strategies/:id/runs") {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      description: "当前团队、当前操作者和创建运行操作范围内的幂等键。原值不会落库；相同请求重放返回当前 Run 状态。",
      schema: {
        type: "string",
        minLength: 8,
        maxLength: 200,
        pattern: "^[A-Za-z0-9._:-]+$"
      }
    });
  }
  if (path === "/api/prospects/:id/convert-to-lead") {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      description: "当前团队、当前登录业务员和候选客户范围内的人工转换幂等键；原值不会落库。",
      schema: {
        type: "string",
        minLength: 8,
        maxLength: 200,
        pattern: "^[A-Za-z0-9._:-]+$"
      }
    });
  }
  if (path === "/api/prospects/:id/convert-to-customer") {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      description: "当前团队、当前登录业务员和候选客户范围内的人工客户入库幂等键；原值不会落库。",
      schema: {
        type: "string",
        minLength: 8,
        maxLength: 200,
        pattern: "^[A-Za-z0-9._:-]+$"
      }
    });
  }
  if (method !== "get" && (
    path === "/api/prospect-campaigns/:id"
    || path === "/api/prospect-campaigns/:id/versions"
    || path === "/api/prospect-campaigns/:id/strategies"
    || path === "/api/prospect-campaigns/:id/activate"
    || path === "/api/prospect-campaigns/:id/pause"
    || path === "/api/prospect-campaigns/:id/complete"
    || path === "/api/prospect-campaigns/:id/archive"
  )) {
    parameters.push({
      name: "If-Match",
      in: "header",
      required: true,
      description: "使用获客项目 GET/创建/上次修改响应中的 ETag，防止并发覆盖。",
      schema: {
        type: "string",
        example: "\"pc_00000000-0000-4000-8000-000000000000:1\""
      }
    });
  }
  if (method !== "get" && (
    path === "/api/prospect-schedules/:id/pause"
    || path === "/api/prospect-schedules/:id/resume"
    || path === "/api/prospect-schedules/:id"
  )) {
    parameters.push({
      name: "If-Match",
      in: "header",
      required: true,
      description: "使用定时计划创建或上次修改响应中的 ETag，防止并发覆盖。",
      schema: {
        type: "string",
        example: "\"psc_00000000-0000-4000-8000-000000000000:1\""
      }
    });
  }
  if (method !== "get" && (
    path === "/api/prospect-strategies/:id"
    || path === "/api/prospect-strategies/:id/approve"
    || path === "/api/prospect-strategies/:id/disable"
    || path === "/api/prospect-strategies/:id/runs"
    || path === "/api/prospect-strategies/:id/schedules"
  )) {
    parameters.push({
      name: "If-Match",
      in: "header",
      required: true,
      description: "使用策略 GET/创建/上次修改响应中的 ETag，防止并发覆盖。",
      schema: {
        type: "string",
        example: "\"ps_00000000-0000-4000-8000-000000000000:1\""
      }
    });
  }
  if (method !== "get" && (
    path === "/api/prospect-runs/:id/pause"
    || path === "/api/prospect-runs/:id/resume"
    || path === "/api/prospect-runs/:id/cancel"
  )) {
    parameters.push({
      name: "If-Match",
      in: "header",
      required: true,
      description: "使用 Run GET、创建或上次状态变更响应中的 ETag，防止并发状态覆盖。",
      schema: {
        type: "string",
        example: "\"pr_00000000-0000-4000-8000-000000000000:1\""
      }
    });
  }
  if (
    method === "post"
    && path === "/api/organization-identity-conflicts/:id/review"
  ) {
    parameters.push({
      name: "If-Match",
      in: "header",
      required: true,
      description: "使用冲突列表返回的 etag，避免两名管理员重复处理同一冲突。",
      schema: {
        type: "string",
        example:
          "\"organization-identity-conflict:oic_00000000-0000-4000-8000-000000000000:1\""
      }
    });
  }
  if (method === "get" && path === "/api/prospect-runs") {
    parameters.push(
      {
        name: "campaignId",
        in: "query",
        schema: { type: "string", maxLength: 80 }
      },
      {
        name: "strategyId",
        in: "query",
        schema: { type: "string", maxLength: 80 }
      },
      {
        name: "ownerId",
        in: "query",
        description: "经理和管理员可筛选本团队负责人；业务员仍只会得到当前归自己负责项目的运行。",
        schema: { type: "string", maxLength: 64 }
      },
      {
        name: "status",
        in: "query",
        schema: { type: "string", enum: ["queued", "paused", "cancelled"] }
      },
      {
        name: "cursor",
        in: "query",
        description: "绑定当前账号角色、团队和全部筛选条件的不透明签名游标。",
        schema: { type: "string", minLength: 1, maxLength: 2048 }
      },
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 100, default: 30 }
      }
    );
  }
  if (path === "/api/prospect-campaigns/:id/trade-observations") {
    parameters.push(
      {
        name: "providerId",
        in: "query",
        schema: { type: "string", maxLength: 80, pattern: "^[A-Za-z0-9._-]+$" }
      },
      {
        name: "reporterCode",
        in: "query",
        schema: { type: "string", maxLength: 16, pattern: "^[A-Za-z0-9._-]+$" }
      },
      {
        name: "partnerCode",
        in: "query",
        schema: { type: "string", maxLength: 16, pattern: "^[A-Za-z0-9._-]+$" }
      },
      {
        name: "flow",
        in: "query",
        schema: { type: "string", enum: ["import", "export"] }
      },
      {
        name: "classification",
        in: "query",
        schema: { type: "string", maxLength: 40, pattern: "^[A-Za-z0-9._-]+$" }
      },
      {
        name: "commodityCode",
        in: "query",
        schema: { type: "string", maxLength: 32, pattern: "^[A-Za-z0-9._-]+$" }
      },
      {
        name: "periodType",
        in: "query",
        description: "年度使用 annual，月度使用 monthly；若同时提供期间，格式必须一致。",
        schema: { type: "string", enum: ["annual", "monthly"] }
      },
      {
        name: "period",
        in: "query",
        description: "精确期间，年度为 YYYY，月度为 YYYY-MM；不能与期间区间同时使用。",
        schema: { type: "string", pattern: "^\\d{4}(?:-(?:0[1-9]|1[0-2]))?$" }
      },
      {
        name: "periodFrom",
        in: "query",
        description: "区间起点，必须与 periodTo 成对提供且期间类型相同。",
        schema: { type: "string", pattern: "^\\d{4}(?:-(?:0[1-9]|1[0-2]))?$" }
      },
      {
        name: "periodTo",
        in: "query",
        description: "区间终点，必须不早于 periodFrom。",
        schema: { type: "string", pattern: "^\\d{4}(?:-(?:0[1-9]|1[0-2]))?$" }
      },
      {
        name: "cursor",
        in: "query",
        description: "不透明分页游标，绑定当前账号、兼容项目引用、全部筛选条件和匹配数据集。",
        schema: { type: "string", minLength: 1, maxLength: 2048 }
      },
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 200, default: 50 }
      }
    );
  }
  if (path === "/api/prospect-campaigns/:id/market-opportunities") {
    parameters.push(
      {
        name: "batchId",
        in: "query",
        description: "显式读取当前登录人名下的历史事实批次；省略时严格读取最近一次计算事件指向的批次。",
        schema: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          pattern: "^[A-Za-z0-9._:-]+$"
        }
      },
      {
        name: "countryCode",
        in: "query",
        schema: { type: "string", maxLength: 16, pattern: "^[A-Za-z0-9._-]+$" }
      },
      {
        name: "classification",
        in: "query",
        schema: { type: "string", maxLength: 40, pattern: "^[A-Za-z0-9._-]+$" }
      },
      {
        name: "commodityCode",
        in: "query",
        schema: { type: "string", maxLength: 32, pattern: "^[A-Za-z0-9._-]+$" }
      },
      {
        name: "snapshotStatus",
        in: "query",
        schema: {
          type: "string",
          enum: ["metrics_ready", "insufficient_data"]
        }
      },
      {
        name: "cursor",
        in: "query",
        description: "不透明分页游标，绑定当前账号、项目、事实批次和全部筛选条件。",
        schema: { type: "string", minLength: 1, maxLength: 2048 }
      },
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 100, default: 50 }
      }
    );
  }
  return parameters;
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
    : method === "post"
      && path === "/api/organization-identity-conflicts/:id/review"
      ? {
          type: "object",
          required: ["action", "note"],
          properties: {
            action: {
              type: "string",
              enum: ["keep_separate", "merge"],
              description: "保持独立或建立规范企业映射。"
            },
            canonicalOrganizationId: {
              type: "string",
              maxLength: 90,
              description:
                "action=merge 时必填，且必须是当前冲突内的候选企业；保持独立时必须为空。"
            },
            note: {
              type: "string",
              minLength: 2,
              maxLength: 1000,
              description: "不可覆盖的人工复核依据。"
            }
          },
          additionalProperties: false
        }
    : method === "post" && path === "/api/organizations/:id/aliases"
      ? {
          type: "object",
          required: [
            "aliasType",
            "aliasName",
            "sourceLabel",
            "evidenceSummary"
          ],
          properties: {
            aliasType: {
              type: "string",
              enum: [
                "legal_name",
                "trading_name",
                "brand",
                "previous_name",
                "localized_name"
              ]
            },
            aliasName: { type: "string", minLength: 2, maxLength: 300 },
            locale: { type: "string", maxLength: 40 },
            jurisdiction: { type: "string", maxLength: 100 },
            sourceLabel: { type: "string", minLength: 2, maxLength: 120 },
            sourceReference: {
              type: "string",
              maxLength: 500,
              description: "来源记录编号或公开证据地址。"
            },
            evidenceSummary: {
              type: "string",
              minLength: 2,
              maxLength: 1000
            },
            verificationStatus: {
              type: "string",
              enum: ["reported", "verified"],
              default: "reported"
            },
            observedAt: { type: "string", format: "date-time" }
          },
          additionalProperties: false
        }
    : method === "post" && path === "/api/organization-relations"
      ? {
          type: "object",
          required: [
            "sourceOrganizationId",
            "targetOrganizationId",
            "relationType",
            "sourceLabel",
            "evidenceSummary"
          ],
          properties: {
            sourceOrganizationId: { type: "string", maxLength: 90 },
            targetOrganizationId: { type: "string", maxLength: 90 },
            relationType: {
              type: "string",
              enum: [
                "direct_parent",
                "ultimate_parent",
                "branch_of",
                "brand_of",
                "affiliate"
              ],
              description:
                "方向固定为来源企业指向母公司、最终母公司、所属分支、所属品牌主体或关联企业。"
            },
            sourceLabel: { type: "string", minLength: 2, maxLength: 120 },
            sourceReference: {
              type: "string",
              maxLength: 500,
              description: "来源记录编号或公开证据地址。"
            },
            evidenceSummary: {
              type: "string",
              minLength: 2,
              maxLength: 1000
            },
            verificationStatus: {
              type: "string",
              enum: ["reported", "verified"],
              default: "reported"
            },
            observedAt: { type: "string", format: "date-time" }
          },
          additionalProperties: false
        }
    : method === "post" && path === "/api/prospects/:id/convert-to-lead"
      ? {
          type: "object",
          required: [
            "operationCode",
            "decisionId",
            "mode",
            "existingLeadId",
            "company",
            "contact",
            "country",
            "intent",
            "estimatedAmount",
            "nextFollowAt",
            "remark"
          ],
          properties: {
            operationCode: {
              type: "string",
              enum: ["convert_prospect_to_lead_v1"]
            },
            decisionId: {
              type: "string",
              minLength: 1,
              maxLength: 90,
              description: "当前登录业务员本人完成的、仍有效的人工可联系批准记录。"
            },
            mode: {
              type: "string",
              enum: ["create_new", "link_existing"]
            },
            existingLeadId: {
              type: "string",
              maxLength: 64,
              description: "link_existing 时必填，且必须是当前登录业务员自己的未删除线索；create_new 时必须为空。"
            },
            company: { type: "string", maxLength: 200 },
            contact: { type: "string", maxLength: 100 },
            country: { type: "string", maxLength: 80 },
            intent: {
              type: "string",
              enum: ["高", "中", "低"]
            },
            estimatedAmount: {
              type: "number",
              minimum: 0,
              maximum: 999999999999
            },
            nextFollowAt: { type: "string", maxLength: 100 },
            remark: { type: "string", maxLength: 2000 }
          },
          additionalProperties: false
        }
    : method === "post" && path === "/api/prospects/:id/convert-to-customer"
      ? {
          type: "object",
          required: ["operationCode", "leadId", "mode"],
          properties: {
            operationCode: {
              type: "string",
              enum: ["convert_prospect_to_customer_v1"]
            },
            leadId: {
              type: "string",
              minLength: 1,
              maxLength: 64,
              description: "该候选客户此前通过可信来源链关联的、当前登录业务员本人的线索。"
            },
            mode: {
              type: "string",
              enum: ["create_new", "link_existing"]
            },
            existingCustomerId: {
              type: "string",
              maxLength: 64,
              description: "link_existing 时必填，且必须是当前登录业务员自己的客户；create_new 时必须为空。"
            },
            company: {
              type: "string",
              maxLength: 200,
              description: "仅 create_new 可选；为空时沿用线索公司名。"
            },
            contact: {
              type: "string",
              maxLength: 100,
              description: "仅 create_new 可选；为空时沿用线索联系人。"
            },
            country: {
              type: "string",
              maxLength: 80,
              description: "仅 create_new 可选；为空时沿用线索国家。"
            },
            nextReminder: {
              type: "string",
              maxLength: 100,
              description: "仅 create_new 可选；为空时沿用线索下次跟进时间。"
            }
          },
          additionalProperties: false
        }
    : method === "post" && path === "/api/prospect-campaigns"
      ? {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 160 },
            ownerId: {
              type: "string",
              maxLength: 64,
              description: "仅经理或管理员可指定本团队有效负责人；业务员默认本人。"
            },
            snapshot: { $ref: "#/components/schemas/ProspectCampaignSnapshotInput" }
          },
          additionalProperties: false
        }
    : method === "patch" && path === "/api/prospect-campaigns/:id"
      ? {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 160 },
            ownerId: {
              type: "string",
              maxLength: 64,
              description: "仅经理或管理员可转交给本团队有效负责人。"
            },
            reason: { type: "string", maxLength: 500 }
          },
          additionalProperties: false
        }
    : method === "post" && path === "/api/prospect-campaigns/:id/versions"
      ? {
          type: "object",
          required: ["snapshot"],
          properties: {
            snapshot: { $ref: "#/components/schemas/ProspectCampaignSnapshotInput" },
            changeSummary: { type: "string", maxLength: 500 }
          },
          additionalProperties: false
        }
    : method === "post" && path === "/api/prospect-campaigns/:id/strategies"
      ? {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 160 },
            query: { $ref: "#/components/schemas/ProspectStrategyQueryInput" },
            providerPlan: {
              type: "array",
              maxItems: 30,
              items: { $ref: "#/components/schemas/ProspectStrategyProviderPlanItem" }
            },
            copyFromStrategyId: {
              type: "string",
              pattern: "^ps_[0-9a-fA-F-]{36}$",
              description: "复制同一项目中可见的历史策略为当前版本草稿；使用时不能同时提交 query 或 providerPlan。"
            }
          },
          additionalProperties: false
        }
    : method === "patch" && path === "/api/prospect-strategies/:id"
      ? {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 160 },
            query: { $ref: "#/components/schemas/ProspectStrategyQueryInput" },
            providerPlan: {
              type: "array",
              maxItems: 30,
              items: { $ref: "#/components/schemas/ProspectStrategyProviderPlanItem" }
            },
            reason: { type: "string", maxLength: 500 }
          },
          additionalProperties: false
        }
    : method === "post" && path === "/api/prospect-strategies/:id/preview"
      ? {
          type: "object",
          properties: {
            query: { $ref: "#/components/schemas/ProspectStrategyQueryInput" },
            providerPlan: {
              type: "array",
              maxItems: 30,
              items: { $ref: "#/components/schemas/ProspectStrategyProviderPlanItem" }
            }
          },
          additionalProperties: false
        }
    : method === "post" && (
      path === "/api/prospect-strategies/:id/approve"
      || path === "/api/prospect-strategies/:id/disable"
    )
      ? {
          type: "object",
          properties: {
            reason: { type: "string", maxLength: 500 }
          },
          additionalProperties: false
        }
    : method === "post" && (
      path === "/api/prospect-strategies/:id/runs"
      || path === "/api/prospect-runs/:id/pause"
      || path === "/api/prospect-runs/:id/resume"
      || path === "/api/prospect-runs/:id/cancel"
    )
      ? {
          type: "object",
          properties: {
            reason: { type: "string", maxLength: 500 }
          },
          additionalProperties: false
        }
    : method === "post" && (
      path === "/api/prospect-campaigns/:id/activate"
      || path === "/api/prospect-campaigns/:id/pause"
      || path === "/api/prospect-campaigns/:id/complete"
      || path === "/api/prospect-campaigns/:id/archive"
    )
      ? {
          type: "object",
          properties: {
            reason: { type: "string", maxLength: 500 }
          },
          additionalProperties: false
        }
    : path === "/api/prospect-campaigns/:id/market-analysis-runs"
      ? {
          type: "object",
          required: [
            "reporterCodes",
            "partnerCodes",
            "flow",
            "hsVersion",
            "commodityCodes",
            "periods",
            "frequency"
          ],
          properties: {
            providerId: { type: "string", default: "un_comtrade", example: "un_comtrade" },
            reporterCodes: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              description: "代码体系由 Provider 决定：un_comtrade 使用 1 至 3 位 UN 代码；us_census_trade 当前仅接受 842。",
              items: { type: "string", pattern: "^\\d{1,4}$" },
              example: ["842"]
            },
            partnerCodes: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              description: "代码体系由 Provider 决定：un_comtrade 使用 1 至 3 位 UN 代码；us_census_trade 严格使用单个 4 位 Census CTY_CODE。",
              items: { type: "string", pattern: "^\\d{1,4}$" },
              example: ["0"]
            },
            flow: { type: "string", enum: ["import", "export"], example: "import" },
            hsVersion: { type: "string", enum: ["HS", "HS2017", "HS2022"], example: "HS2022" },
            commodityCodes: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: { type: "string", pattern: "^\\d{2,6}$" },
              example: ["940542"]
            },
            periods: {
              type: "array",
              minItems: 1,
              maxItems: 36,
              items: { type: "string", pattern: "^\\d{4}(?:\\d{2})?$" },
              example: ["2023"]
            },
            frequency: { type: "string", enum: ["annual", "monthly"], example: "annual" },
            limit: { type: "integer", minimum: 1, maximum: 500, default: 500 }
          },
          additionalProperties: false
        }
    : {
        type: "object",
        description: "字段以对应业务页面提交内容为准；服务端会继续执行 Zod 参数校验。",
        additionalProperties: true
      };
  return {
    required: path.startsWith("/api/prospect-campaigns")
      || path.startsWith("/api/prospect-strategies")
      || path.startsWith("/api/prospect-runs")
      || path === "/api/organization-identity-conflicts/:id/review"
      || path === "/api/organizations/:id/aliases"
      || path === "/api/organization-relations",
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

const publicAgentJobSchema = {
  type: "object",
  required: [
    "id",
    "teamId",
    "ownerId",
    "jobType",
    "aggregateType",
    "aggregateId",
    "status",
    "attemptCount",
    "maxAttempts",
    "nextAttemptAt",
    "errorCode",
    "failureReason",
    "traceId",
    "createdAt"
  ],
  properties: {
    id: { type: "string" },
    teamId: { type: "string" },
    ownerId: { type: "string" },
    jobType: { type: "string" },
    aggregateType: { type: "string" },
    aggregateId: { type: "string" },
    parentJobId: { type: "string" },
    status: {
      type: "string",
      enum: [
        "queued",
        "running",
        "retry_scheduled",
        "succeeded",
        "failed",
        "cancelled",
        "dead_letter"
      ]
    },
    priority: { type: "integer" },
    policyVersion: { type: "string" },
    attemptCount: { type: "integer" },
    maxAttempts: { type: "integer" },
    nextAttemptAt: { type: "string" },
    errorCode: { type: "string" },
    failureReason: { type: "string" },
    traceId: { type: "string" },
    startedAt: { type: "string" },
    finishedAt: { type: "string" },
    createdAt: { type: "string" }
  },
  additionalProperties: false
};

const marketAnalysisMetadataProperties = {
  campaignContractMode: { type: "string", enum: ["compat_v1", "formal_v1"] },
  campaignScope: { type: "string", enum: ["owner"] },
  executionMode: { type: "string", enum: ["inline_single_instance_v1"] },
  retryMode: { type: "string", enum: ["manual"] },
  autoRetryScheduled: { type: "boolean", enum: [false] }
};

const marketAnalysisQuerySchema = {
  type: "object",
  required: [
    "reporterCodes",
    "partnerCodes",
    "flow",
    "hsVersion",
    "commodityCodes",
    "periods",
    "frequency",
    "limit"
  ],
  properties: {
    reporterCodes: { type: "array", items: { type: "string" } },
    partnerCodes: { type: "array", items: { type: "string" } },
    flow: { type: "string", enum: ["import", "export"] },
    hsVersion: { type: "string", enum: ["HS", "HS2017", "HS2022"] },
    commodityCodes: { type: "array", items: { type: "string" } },
    periods: { type: "array", items: { type: "string" } },
    frequency: { type: "string", enum: ["annual", "monthly"] },
    limit: { type: "integer", minimum: 1, maximum: 500 }
  },
  additionalProperties: false
};

const marketAnalysisObservationSchema = {
  type: "object",
  required: [
    "id",
    "providerId",
    "reporterCountry",
    "reporterCode",
    "partnerCountry",
    "partnerCode",
    "tradeFlow",
    "classification",
    "commodityCode",
    "commodityDescription",
    "period",
    "tradeValueUsd",
    "netWeightKg",
    "quantity",
    "quantityUnit",
    "isAggregate",
    "suppressed",
    "statusFlags",
    "adapterVersion",
    "sourceRevision",
    "observedAt"
  ],
  properties: {
    id: { type: "string" },
    providerId: { type: "string" },
    reporterCountry: { type: "string" },
    reporterCode: { type: "string" },
    partnerCountry: { type: "string" },
    partnerCode: { type: "string" },
    tradeFlow: { type: "string", enum: ["IMPORT", "EXPORT"] },
    classification: { type: "string" },
    commodityCode: { type: "string" },
    commodityDescription: { type: "string" },
    period: { type: "string" },
    tradeValueUsd: { type: "number", nullable: true },
    netWeightKg: { type: "number", nullable: true },
    quantity: { type: "number", nullable: true },
    quantityUnit: { type: "string", nullable: true },
    isAggregate: { type: "boolean" },
    suppressed: { type: "boolean" },
    statusFlags: { type: "array", items: { type: "string" } },
    adapterVersion: { type: "string" },
    sourceRevision: { type: "string", nullable: true },
    observedAt: { type: "string", format: "date-time" }
  },
  additionalProperties: false
};

const marketAnalysisResultSchema = {
  type: "object",
  nullable: true,
  required: [
    "resultScope",
    "providerId",
    "status",
    "cacheStatus",
    "rawCount",
    "validCount",
    "invalidCount",
    "duplicateCount",
    "createdCount",
    "updatedCount",
    "exhausted",
    "nextCursor",
    "warnings",
    "usage",
    "querySummary",
    "observations",
    "marketOpportunityCalculation"
  ],
  properties: {
    resultScope: {
      type: "string",
      enum: ["job_execution"],
      description: "所有计数均属于底层任务的那一次真实执行；幂等重放不会重新计算为本次 HTTP 请求的新增量。"
    },
    providerId: { type: "string" },
    status: { type: "string" },
    cacheStatus: { type: "string" },
    rawCount: { type: "integer" },
    validCount: { type: "integer" },
    invalidCount: { type: "integer" },
    duplicateCount: { type: "integer" },
    createdCount: {
      type: "integer",
      description: "底层任务执行时新建的市场观测记录数；幂等重放会返回同一数值，不表示再次写入。"
    },
    updatedCount: {
      type: "integer",
      description: "底层任务执行时匹配并覆盖写入的既有观测记录数，不代表官方源数据一定发生变化。"
    },
    exhausted: {
      type: "boolean",
      description: "Provider 是否确认结果已经完整耗尽；达到单页上限时不能据此判断完整。"
    },
    nextCursor: { type: "string", nullable: true },
    warnings: { type: "array", items: { type: "string" } },
    usage: { type: "object", additionalProperties: true },
    querySummary: marketAnalysisQuerySchema,
    observations: {
      type: "array",
      description: "本次底层任务实际持久化的安全观测明细，不包含团队、负责人、原始记录标识或载荷哈希。",
      items: marketAnalysisObservationSchema
    },
    marketOpportunityCalculation: {
      type: "object",
      nullable: true,
      required: [
        "batchId",
        "eventId",
        "datasetFingerprint",
        "policyVersion",
        "outcome",
        "reusedBatch"
      ],
      properties: {
        batchId: { type: "string" },
        eventId: { type: "string" },
        datasetFingerprint: {
          type: "string",
          pattern: "^[a-f0-9]{64}$",
          description: "用于判定事实数据集是否变化的服务端指纹。"
        },
        policyVersion: {
          type: "string",
          enum: ["market_opportunity_facts_v1"]
        },
        outcome: {
          type: "string",
          enum: ["metrics_ready", "partial", "insufficient_data"]
        },
        reusedBatch: {
          type: "boolean",
          description: "相同事实数据集和策略版本是否复用了既有不可变批次。"
        }
      },
      additionalProperties: false
    }
  },
  additionalProperties: false
};

const marketAnalysisResponseSchema = {
  type: "object",
  required: [
    "duplicate",
    "campaignContractMode",
    "campaignScope",
    "executionMode",
    "retryMode",
    "autoRetryScheduled",
    "job",
    "result"
  ],
  properties: {
    duplicate: {
      type: "boolean",
      description: "true 表示本次 HTTP 请求解析到既有或并发共享的任务；不等同于“没有发生允许的任务重试”。"
    },
    ...marketAnalysisMetadataProperties,
    job: publicAgentJobSchema,
    result: marketAnalysisResultSchema
  },
  additionalProperties: false
};

const marketAnalysisRequestErrorSchema = {
  type: "object",
  required: ["message", "errorCode"],
  properties: {
    message: { type: "string" },
    errorCode: { type: "string" },
    ...marketAnalysisMetadataProperties
  },
  additionalProperties: false
};

const marketAnalysisProviderErrorSchema = {
  type: "object",
  required: [
    "message",
    "errorCode",
    "retryable",
    "retryAfterAt",
    "campaignContractMode",
    "campaignScope",
    "executionMode",
    "retryMode",
    "autoRetryScheduled",
    "job"
  ],
  properties: {
    message: { type: "string" },
    errorCode: { type: "string" },
    retryable: { type: "boolean" },
    retryAfterAt: { type: "string", format: "date-time", nullable: true },
    ...marketAnalysisMetadataProperties,
    job: publicAgentJobSchema
  },
  additionalProperties: false
};

const tradeObservationListFiltersSchema = {
  type: "object",
  required: [
    "providerId",
    "reporterCode",
    "partnerCode",
    "flow",
    "classification",
    "commodityCode",
    "periodType",
    "period",
    "periodFrom",
    "periodTo"
  ],
  properties: {
    providerId: { type: "string", nullable: true },
    reporterCode: { type: "string", nullable: true },
    partnerCode: { type: "string", nullable: true },
    flow: { type: "string", enum: ["import", "export"], nullable: true },
    classification: { type: "string", nullable: true },
    commodityCode: { type: "string", nullable: true },
    periodType: { type: "string", enum: ["annual", "monthly"], nullable: true },
    period: { type: "string", nullable: true },
    periodFrom: { type: "string", nullable: true },
    periodTo: { type: "string", nullable: true }
  },
  additionalProperties: false
};

const tradeObservationListItemSchema = {
  type: "object",
  required: [
    "id",
    "providerId",
    "reporterCountry",
    "reporterCode",
    "partnerCountry",
    "partnerCode",
    "tradeFlow",
    "classification",
    "commodityCode",
    "commodityDescription",
    "periodType",
    "period",
    "tradeValueUsd",
    "tradeValueState",
    "netWeightKg",
    "netWeightState",
    "quantity",
    "quantityUnit",
    "quantityState",
    "isAggregate",
    "suppressed",
    "statusFlags",
    "adapterVersion",
    "sourceRevision",
    "observedAt",
    "createdAt"
  ],
  properties: {
    id: { type: "string" },
    providerId: { type: "string" },
    reporterCountry: { type: "string" },
    reporterCode: { type: "string" },
    partnerCountry: { type: "string" },
    partnerCode: { type: "string" },
    tradeFlow: { type: "string", enum: ["IMPORT", "EXPORT"] },
    classification: { type: "string" },
    commodityCode: { type: "string" },
    commodityDescription: { type: "string" },
    periodType: { type: "string", enum: ["annual", "monthly", "unknown"] },
    period: {
      type: "string",
      description: "年度规范为 YYYY，月度规范为 YYYY-MM；unknown 保留来源原值。"
    },
    tradeValueUsd: { type: "number", nullable: true },
    tradeValueState: {
      type: "string",
      enum: ["reported", "reported_zero", "suppressed", "unavailable", "unknown"],
      description: "仅描述 tradeValueUsd；零值不等同于没有贸易。"
    },
    netWeightKg: { type: "number", nullable: true },
    netWeightState: {
      type: "string",
      enum: ["reported", "reported_zero", "unavailable"]
    },
    quantity: { type: "number", nullable: true },
    quantityUnit: { type: "string", nullable: true },
    quantityState: {
      type: "string",
      enum: ["reported", "reported_zero", "unavailable"]
    },
    isAggregate: { type: "boolean" },
    suppressed: { type: "boolean" },
    statusFlags: {
      type: "array",
      items: { type: "string" },
      description: "原样返回持久化的 Provider 状态标记；接口不会根据数值自行合成来源证据。"
    },
    adapterVersion: { type: "string" },
    sourceRevision: { type: "string", nullable: true },
    observedAt: { type: "string", format: "date-time" },
    createdAt: { type: "string", format: "date-time" }
  },
  additionalProperties: false
};

const tradeObservationListResponseSchema = {
  type: "object",
  required: [
    "campaignId",
    "campaignContractMode",
    "campaignScope",
    "observationScope",
    "dataScope",
    "absenceMeaning",
    "sort",
    "filters",
    "total",
    "pageCount",
    "hasMore",
    "nextCursor",
    "observations"
  ],
  properties: {
    campaignId: { type: "string" },
    campaignContractMode: { type: "string", enum: ["compat_v1", "formal_v1"] },
    campaignScope: { type: "string", enum: ["owner"] },
    observationScope: {
      type: "string",
      enum: ["campaign_current_observations"]
    },
    dataScope: {
      type: "string",
      enum: ["country_trade_statistics"]
    },
    absenceMeaning: {
      type: "string",
      enum: ["not_observed_not_zero"]
    },
    sort: {
      type: "string",
      enum: ["period_desc_created_desc_id_desc"]
    },
    filters: tradeObservationListFiltersSchema,
    total: {
      type: "integer",
      minimum: 0,
      description: "当前账号权限和全部生效筛选下、应用 cursor 前的完整匹配数。"
    },
    pageCount: { type: "integer", minimum: 0 },
    hasMore: { type: "boolean" },
    nextCursor: { type: "string", nullable: true },
    observations: {
      type: "array",
      items: tradeObservationListItemSchema
    }
  },
  additionalProperties: false
};

const tradeObservationListRequestErrorSchema = {
  type: "object",
  required: ["message", "errorCode"],
  properties: {
    message: { type: "string" },
    errorCode: {
      type: "string",
      enum: ["TRADE_OBSERVATION_CURSOR_INVALID"]
    }
  },
  additionalProperties: false
};

const marketOpportunityCalculationSchema = {
  type: "object",
  nullable: true,
  required: [
    "eventId",
    "triggerJobId",
    "batchId",
    "outcome",
    "reusedBatch",
    "sequence",
    "calculatedAt"
  ],
  properties: {
    eventId: { type: "string" },
    triggerJobId: { type: "string" },
    batchId: { type: "string" },
    outcome: {
      type: "string",
      enum: ["metrics_ready", "partial", "insufficient_data"]
    },
    reusedBatch: { type: "boolean" },
    sequence: {
      type: "integer",
      minimum: 1,
      description: "单调递增的计算事件顺序；同一时间戳下仍用于确定最新事件。"
    },
    calculatedAt: { type: "string", format: "date-time" }
  },
  additionalProperties: false
};

const marketOpportunityBatchSchema = {
  type: "object",
  nullable: true,
  required: [
    "id",
    "providerId",
    "policyVersion",
    "status",
    "emptyReason",
    "candidateCount",
    "readyCount",
    "comparisonPeriods",
    "firstTriggerJobId",
    "observationCutoffAt",
    "createdAt"
  ],
  properties: {
    id: { type: "string" },
    providerId: { type: "string", enum: ["un_comtrade"] },
    policyVersion: {
      type: "string",
      enum: ["market_opportunity_facts_v1"]
    },
    status: {
      type: "string",
      enum: ["metrics_ready", "partial", "insufficient_data"]
    },
    emptyReason: {
      type: "string",
      nullable: true,
      enum: [
        "no_eligible_observations",
        "missing_world_series",
        "non_contiguous_three_year_series",
        "all_candidates_insufficient"
      ]
    },
    candidateCount: { type: "integer", minimum: 0 },
    readyCount: { type: "integer", minimum: 0 },
    comparisonPeriods: {
      type: "array",
      items: { type: "string", pattern: "^\\d{4}$" }
    },
    firstTriggerJobId: { type: "string" },
    observationCutoffAt: {
      type: "string",
      format: "date-time",
      nullable: true,
      description: "该不可变批次所使用合格观测数据中的最晚观测时间。"
    },
    createdAt: { type: "string", format: "date-time" }
  },
  additionalProperties: false
};

const marketOpportunityEvidenceSchema = {
  type: "object",
  required: [
    "observationId",
    "providerId",
    "adapterVersion",
    "sourceRevision",
    "period",
    "reporterCountry",
    "reporterCode",
    "partnerCountry",
    "partnerCode",
    "tradeFlow",
    "classification",
    "commodityCode",
    "reportedImportValueUsd",
    "suppressed",
    "statusFlags"
  ],
  properties: {
    observationId: { type: "string" },
    providerId: { type: "string", enum: ["un_comtrade"] },
    adapterVersion: { type: "string" },
    sourceRevision: { type: "string", nullable: true },
    period: { type: "string", pattern: "^\\d{4}$" },
    reporterCountry: { type: "string" },
    reporterCode: { type: "string" },
    partnerCountry: { type: "string" },
    partnerCode: { type: "string" },
    tradeFlow: { type: "string", enum: ["IMPORT"] },
    classification: { type: "string" },
    commodityCode: { type: "string" },
    reportedImportValueUsd: {
      type: "number",
      nullable: true,
      description: "来源记录中的报告进口额（美元），不是市场规模、采购预算或成交预测。"
    },
    suppressed: { type: "boolean" },
    statusFlags: { type: "array", items: { type: "string" } }
  },
  additionalProperties: false
};

const marketOpportunityRateChangeSchema = {
  type: "object",
  required: ["fromPeriod", "toPeriod", "value", "reason"],
  properties: {
    fromPeriod: { type: "string", pattern: "^\\d{4}$" },
    toPeriod: { type: "string", pattern: "^\\d{4}$" },
    value: {
      type: "number",
      nullable: true,
      description: "小数比例；0.1 表示增长 10%。"
    },
    reason: { type: "string" }
  },
  additionalProperties: false
};

const marketOpportunityMetricsSchema = {
  type: "object",
  required: [
    "metricVersion",
    "reportedImportValueSeries",
    "yoyChanges",
    "twoYearCagr",
    "twoYearCagrReason",
    "chinaMainlandSupplyShare",
    "chinaMainlandSupplyShareReason",
    "chinaMainlandEvidence"
  ],
  properties: {
    metricVersion: {
      type: "string",
      enum: ["market_opportunity_facts_v1"]
    },
    reportedImportValueSeries: {
      type: "array",
      description: "同一商品口径和共同对比期下的三年 WORLD 报告进口额事实序列。",
      items: {
        type: "object",
        required: ["period", "reportedImportValueUsd", "evidence"],
        properties: {
          period: { type: "string", pattern: "^\\d{4}$" },
          reportedImportValueUsd: { type: "number", minimum: 0 },
          evidence: marketOpportunityEvidenceSchema
        },
        additionalProperties: false
      }
    },
    yoyChanges: {
      type: "array",
      items: marketOpportunityRateChangeSchema
    },
    twoYearCagr: { type: "number", nullable: true },
    twoYearCagrReason: { type: "string", nullable: true },
    chinaMainlandSupplyShare: {
      type: "number",
      nullable: true,
      minimum: 0,
      maximum: 1,
      description: "中国大陆伙伴代码 156 的报告进口额占 WORLD 伙伴代码 0 的比例。"
    },
    chinaMainlandSupplyShareReason: { type: "string", nullable: true },
    chinaMainlandEvidence: {
      ...marketOpportunityEvidenceSchema,
      nullable: true
    }
  },
  additionalProperties: false
};

const marketOpportunityItemSchema = {
  type: "object",
  required: [
    "id",
    "country",
    "countryCode",
    "classification",
    "commodityCode",
    "commodityDescription",
    "comparisonPeriod",
    "snapshotStatus",
    "insufficiencyReasons",
    "scoringStatus",
    "metrics"
  ],
  properties: {
    id: { type: "string" },
    country: { type: "string" },
    countryCode: { type: "string" },
    classification: { type: "string" },
    commodityCode: { type: "string" },
    commodityDescription: { type: "string" },
    comparisonPeriod: {
      type: "string",
      nullable: true,
      pattern: "^\\d{4}$"
    },
    snapshotStatus: {
      type: "string",
      enum: ["metrics_ready", "insufficient_data"]
    },
    insufficiencyReasons: {
      type: "array",
      items: { type: "string" }
    },
    scoringStatus: {
      type: "string",
      enum: ["not_scored_v1"]
    },
    metrics: marketOpportunityMetricsSchema
  },
  additionalProperties: false
};

const marketOpportunityListResponseSchema = {
  type: "object",
  required: [
    "campaignId",
    "campaignContractMode",
    "campaignScope",
    "dataScope",
    "opportunityScope",
    "scoringStatus",
    "calculationStatus",
    "absenceMeaning",
    "fallbackReason",
    "interpretation",
    "sort",
    "filters",
    "latestCalculation",
    "selectedCalculation",
    "selectedBatch",
    "lastMetricsReadyBatch",
    "isHistorical",
    "isCurrentDataset",
    "isStale",
    "total",
    "pageCount",
    "hasMore",
    "nextCursor",
    "opportunities"
  ],
  properties: {
    campaignId: { type: "string" },
    campaignContractMode: { type: "string", enum: ["compat_v1", "formal_v1"] },
    campaignScope: { type: "string", enum: ["owner"] },
    dataScope: { type: "string", enum: ["country_trade_statistics"] },
    opportunityScope: {
      type: "string",
      enum: ["market_opportunity_fact_snapshots_v1"]
    },
    scoringStatus: { type: "string", enum: ["not_scored_v1"] },
    calculationStatus: {
      type: "string",
      enum: ["never_calculated", "metrics_ready", "partial", "insufficient_data"]
    },
    absenceMeaning: {
      type: "string",
      enum: ["no_fact_snapshot_does_not_mean_zero_or_no_market"],
      description: "没有匹配事实快照仅表示尚未计算、资料不足或筛选后无记录，不表示报告进口额为零或市场不存在。"
    },
    fallbackReason: {
      type: "string",
      nullable: true,
      enum: [null],
      description: "固定为 null；默认读取严格使用最新计算事件，绝不静默回退历史批次。"
    },
    interpretation: { type: "string" },
    sort: {
      type: "string",
      enum: ["country_classification_commodity_id_asc"]
    },
    filters: {
      type: "object",
      required: [
        "countryCode",
        "classification",
        "commodityCode",
        "snapshotStatus"
      ],
      properties: {
        countryCode: { type: "string", nullable: true },
        classification: { type: "string", nullable: true },
        commodityCode: { type: "string", nullable: true },
        snapshotStatus: {
          type: "string",
          enum: ["metrics_ready", "insufficient_data"],
          nullable: true
        }
      },
      additionalProperties: false
    },
    latestCalculation: marketOpportunityCalculationSchema,
    selectedCalculation: marketOpportunityCalculationSchema,
    selectedBatch: marketOpportunityBatchSchema,
    lastMetricsReadyBatch: marketOpportunityBatchSchema,
    isHistorical: { type: "boolean" },
    isCurrentDataset: {
      type: "boolean",
      description: "所选不可变批次是否仍对应当前登录人、当前项目下的最新合格观测数据集。"
    },
    isStale: {
      type: "boolean",
      description: "所选批次是否已不对应当前合格观测数据集；未计算时为 false。"
    },
    total: { type: "integer", minimum: 0 },
    pageCount: { type: "integer", minimum: 0 },
    hasMore: { type: "boolean" },
    nextCursor: { type: "string", nullable: true },
    opportunities: {
      type: "array",
      items: marketOpportunityItemSchema
    }
  },
  additionalProperties: false
};

const marketOpportunityListRequestErrorSchema = {
  type: "object",
  required: ["message", "errorCode"],
  properties: {
    message: { type: "string" },
    errorCode: {
      type: "string",
      enum: [
        "MARKET_OPPORTUNITY_CURSOR_INVALID",
        "MARKET_OPPORTUNITY_BATCH_NOT_FOUND"
      ]
    }
  },
  additionalProperties: false
};

function responsesFor(method: HttpMethod, path: string) {
  const responses: Record<string, unknown> = {
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
  };
  const campaignMutation = method !== "get" && (
    path === "/api/prospect-campaigns/:id"
    || path === "/api/prospect-campaigns/:id/versions"
    || path === "/api/prospect-campaigns/:id/strategies"
    || path === "/api/prospect-campaigns/:id/activate"
    || path === "/api/prospect-campaigns/:id/pause"
    || path === "/api/prospect-campaigns/:id/complete"
    || path === "/api/prospect-campaigns/:id/archive"
  );
  const strategyMutation = method !== "get" && (
    path === "/api/prospect-strategies/:id"
    || path === "/api/prospect-strategies/:id/approve"
    || path === "/api/prospect-strategies/:id/disable"
  );
  const runMutation = method !== "get" && (
    path === "/api/prospect-strategies/:id/runs"
    || path === "/api/prospect-runs/:id/pause"
    || path === "/api/prospect-runs/:id/resume"
    || path === "/api/prospect-runs/:id/cancel"
  );
  const identityConflictReviewMutation =
    method === "post"
    && path === "/api/organization-identity-conflicts/:id/review";
  const organizationFactMutation =
    method === "post"
    && (
      path === "/api/organizations/:id/aliases"
      || path === "/api/organization-relations"
    );
  if (method === "post" && path === "/api/prospect-campaigns") {
    responses["201"] = {
      description: "草稿项目、版本 1、空白默认 Strategy 和双方创建审计已原子持久化",
      content: {
        "application/json": {
          schema: { type: "object", additionalProperties: true }
        }
      }
    };
  }
  if (method === "post" && path === "/api/prospects/:id/convert-to-lead") {
    const successSchema = {
      type: "object",
      required: [
        "replayed",
        "created",
        "lead",
        "sourceEvent",
        "activity",
        "prospect"
      ],
      properties: {
        replayed: { type: "boolean" },
        created: { type: "boolean" },
        lead: { type: "object", additionalProperties: true },
        sourceEvent: { type: "object", additionalProperties: true },
        activity: { type: "object", additionalProperties: true },
        prospect: { type: "object", additionalProperties: true }
      },
      additionalProperties: false
    };
    const errorSchema = {
      type: "object",
      required: ["message", "errorCode"],
      properties: {
        message: { type: "string" },
        errorCode: { type: "string" }
      },
      additionalProperties: false
    };
    responses["200"] = {
      description: "完全相同的人工转换请求幂等重放，不产生重复线索、来源事件或活动",
      headers: {
        "Idempotency-Replayed": {
          schema: { type: "string", enum: ["true"] }
        }
      },
      content: {
        "application/json": { schema: successSchema }
      }
    };
    responses["201"] = {
      description: "已在一个事务内创建或关联线索，并记录来源、活动和候选转换状态",
      headers: {
        "Idempotency-Replayed": {
          schema: { type: "string", enum: ["false"] }
        }
      },
      content: {
        "application/json": { schema: successSchema }
      }
    };
    responses["400"] = {
      description: "请求体、候选编号或 Idempotency-Key 格式无效",
      content: {
        "application/json": { schema: errorSchema }
      }
    };
    responses["404"] = {
      description: "候选客户或已有线索不存在，或者不属于当前登录业务员",
      content: {
        "application/json": { schema: errorSchema }
      }
    };
    responses["409"] = {
      description: "人工批准无效或过期、候选不可转换或已转换、同一幂等键被用于不同请求",
      content: {
        "application/json": { schema: errorSchema }
      }
    };
    responses["500"] = {
      description: "转换审计链或事务完整性校验失败",
      content: {
        "application/json": { schema: errorSchema }
      }
    };
    responses["503"] = {
      description: "事务并发重试耗尽、提交结果暂无法确认或转换服务不可用",
      content: {
        "application/json": { schema: errorSchema }
      }
    };
  }
  if (method === "post" && path === "/api/prospects/:id/convert-to-customer") {
    const successSchema = {
      type: "object",
      required: [
        "replayed",
        "created",
        "customer",
        "lead",
        "sourceEvent",
        "customerActivity",
        "leadActivity",
        "prospect"
      ],
      properties: {
        replayed: { type: "boolean" },
        created: { type: "boolean" },
        customer: { type: "object", additionalProperties: true },
        lead: { type: "object", additionalProperties: true },
        sourceEvent: { type: "object", additionalProperties: true },
        customerActivity: { type: "object", additionalProperties: true },
        leadActivity: { type: "object", additionalProperties: true },
        prospect: { type: "object", additionalProperties: true }
      },
      additionalProperties: false
    };
    const errorSchema = {
      type: "object",
      required: ["message", "errorCode"],
      properties: {
        message: { type: "string" },
        errorCode: { type: "string" }
      },
      additionalProperties: false
    };
    responses["200"] = {
      description: "完全相同的客户入库请求幂等重放，不产生重复客户、来源审计或活动",
      headers: {
        "Idempotency-Replayed": {
          schema: { type: "string", enum: ["true"] }
        }
      },
      content: {
        "application/json": { schema: successSchema }
      }
    };
    responses["201"] = {
      description: "已在一个事务内新建或关联客户，并保留候选、线索与客户的完整来源链",
      headers: {
        "Idempotency-Replayed": {
          schema: { type: "string", enum: ["false"] }
        }
      },
      content: {
        "application/json": { schema: successSchema }
      }
    };
    responses["400"] = {
      description: "请求体、候选编号或 Idempotency-Key 格式无效",
      content: {
        "application/json": { schema: errorSchema }
      }
    };
    responses["404"] = {
      description: "候选客户、来源线索或已有客户不存在，或者不属于当前登录业务员",
      content: {
        "application/json": { schema: errorSchema }
      }
    };
    responses["409"] = {
      description: "来源链无效、候选不可转换、企业归属冲突、已完成转换或幂等键冲突",
      content: {
        "application/json": { schema: errorSchema }
      }
    };
    responses["500"] = {
      description: "客户来源审计链或事务完整性校验失败",
      content: {
        "application/json": { schema: errorSchema }
      }
    };
    responses["503"] = {
      description: "事务并发重试耗尽、提交结果暂无法确认或转换服务不可用",
      content: {
        "application/json": { schema: errorSchema }
      }
    };
  }
  if (campaignMutation) {
    responses["412"] = {
      description: "If-Match 对应的项目 revision 已过期",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ProspectCampaignError" }
        }
      }
    };
    responses["428"] = {
      description: "缺少 If-Match 并发前置条件",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ProspectCampaignError" }
        }
      }
    };
    responses["409"] = {
      description: "项目状态、版本发布或搜索策略门禁不允许当前操作",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ProspectCampaignError" }
        }
      }
    };
  }
  if (strategyMutation) {
    responses["412"] = {
      description: "If-Match 对应的策略 revision 已过期",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ProspectCampaignError" }
        }
      }
    };
    responses["428"] = {
      description: "缺少 If-Match 并发前置条件",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ProspectCampaignError" }
        }
      }
    };
    responses["409"] = {
      description: "项目状态、策略状态、版本或重复策略门禁不允许当前操作",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ProspectCampaignError" }
        }
      }
    };
  }
  if (runMutation) {
    responses["412"] = {
      description: "If-Match 对应的 Strategy 或 Run revision 已过期",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ProspectRunError" }
        }
      }
    };
    responses["428"] = {
      description: "缺少 If-Match 并发前置条件",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ProspectRunError" }
        }
      }
    };
    responses["409"] = {
      description: "幂等键冲突、活动运行重复、状态迁移非法，或运行快照/分片完整性校验失败",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ProspectRunError" }
        }
      }
    };
  }
  if (identityConflictReviewMutation) {
    responses["409"] = {
      description:
        "冲突已经复核、企业已有其他规范映射，或本次合并会形成映射循环"
    };
    responses["412"] = {
      description: "If-Match 已过期，请刷新冲突列表后重试"
    };
    responses["428"] = {
      description: "缺少 If-Match 并发前置条件"
    };
  }
  if (organizationFactMutation) {
    responses["200"] = {
      description: "同一企业事实重复提交，幂等返回已有记录",
      headers: {
        "Idempotency-Replayed": {
          schema: { type: "string", enum: ["true"] }
        }
      }
    };
    responses["201"] = {
      description: "已保存带来源证据和完整性哈希的企业事实",
      headers: {
        "Idempotency-Replayed": {
          schema: { type: "string", enum: ["false"] }
        }
      }
    };
    if (path === "/api/organization-relations") {
      responses["409"] = {
        description: "同类型层级关系冲突，或本次关系会形成集团层级循环"
      };
    }
  }
  if (method === "post" && path === "/api/prospect-strategies/:id/runs") {
    responses["200"] = {
      description: "完全相同的 Idempotency-Key 请求重放；返回该 Run 的当前状态，不创建新运行",
      headers: {
        "Idempotency-Replayed": {
          schema: { type: "string", enum: ["true"] }
        }
      },
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ProspectRunDetailResponse" }
        }
      }
    };
    responses["201"] = {
      description: "已原子创建 queued Run、Provider Shards 和 created 审计事件；没有调用任何 Provider",
      headers: {
        Location: { schema: { type: "string" } },
        ETag: { schema: { type: "string" } },
        "Idempotency-Replayed": {
          schema: { type: "string", enum: ["false"] }
        }
      },
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ProspectRunDetailResponse" }
        }
      }
    };
    responses["400"] = {
      description: "参数格式错误，或缺少/错误的 Idempotency-Key",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/Error" }
        }
      }
    };
    responses["422"] = {
      description: "项目、策略、Provider 静态策略或当前负责人个人凭据未全部就绪；响应一次返回全部 issues",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ProspectRunError" }
        }
      }
    };
    responses["503"] = {
      description: "数据库唯一键并发冲突后的安全重载暂不可用；不会返回原始数据库错误",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ProspectRunError" }
        }
      }
    };
  }
  if (method === "post" && path === "/api/prospect-runs/:id/resume") {
    responses["422"] = {
      description: "恢复前重新校验项目、策略、Provider 和当前负责人个人凭据未通过",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ProspectRunError" }
        }
      }
    };
  }
  if (method === "get" && path === "/api/prospect-runs") {
    responses["200"] = {
      description: "按 createdAt DESC、id DESC 返回当前账号可见运行；不包含执行结果、原始游标或检查点",
      content: {
        "application/json": {
          schema: { type: "object", additionalProperties: true }
        }
      }
    };
  }
  if (method === "get" && path === "/api/prospect-runs/:id") {
    responses["200"] = {
      description: "返回 Run、Provider Shards 和连续审计 Events；不返回租户键、幂等哈希、请求哈希、快照哈希或原始游标",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ProspectRunDetailResponse" }
        }
      }
    };
  }
  if (method === "post" && path === "/api/prospect-campaigns/:id/activate") {
    responses["422"] = {
      description: "当前版本缺少业务字段，或已审批策略的数据源连接尚未全部就绪；响应一次返回全部问题",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ProspectCampaignError" }
        }
      }
    };
  }
  if (method === "post" && path === "/api/prospect-strategies/:id/approve") {
    responses["422"] = {
      description: "策略关键词、目标范围或 Provider 计划尚未通过审批校验",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ProspectCampaignError" }
        }
      }
    };
  }
  if (method === "post" && path === "/api/prospect-campaigns/:id/market-analysis-runs") {
    responses["400"] = {
      description: "JSON/参数校验失败，或缺少 Idempotency-Key 请求头",
      content: {
        "application/json": {
          schema: {
            oneOf: [
              { $ref: "#/components/schemas/Error" },
              { $ref: "#/components/schemas/MarketAnalysisRequestError" }
            ]
          }
        }
      }
    };
    responses["200"] = {
      description: "已接受的幂等键解析到既有任务；完整 result 可通过携带该幂等键重放本 POST 恢复",
      content: {
        "application/json": { schema: marketAnalysisResponseSchema }
      }
    };
    responses["201"] = {
      description: "市场分析已在当前单实例进程中同步执行并生成任务记录",
      headers: {
        Location: {
          description: "任务状态查询地址；该 GET 只返回任务状态，完整查询结果需重放本 POST",
          schema: { type: "string" }
        }
      },
      content: {
        "application/json": { schema: marketAnalysisResponseSchema }
      }
    };
    responses["409"] = {
      description: "幂等键冲突、数据源配置不可用，或 Provider 策略阻止执行",
      content: {
        "application/json": {
          schema: {
            oneOf: [
              { $ref: "#/components/schemas/MarketAnalysisRequestError" },
              { $ref: "#/components/schemas/MarketAnalysisProviderError" }
            ]
          }
        }
      }
    };
    responses["429"] = {
      description: "上游数据源限流；任务记录为失败状态，不会自动调度，请在 retryAfterAt 后手动重试",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/MarketAnalysisProviderError" }
        }
      }
    };
    responses["502"] = {
      description: "上游数据源执行失败",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/MarketAnalysisProviderError" }
        }
      }
    };
    responses["504"] = {
      description: "上游数据源响应超时",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/MarketAnalysisProviderError" }
        }
      }
    };
    responses["413"] = {
      description: "请求体超过服务端允许大小",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/Error" }
        }
      }
    };
    responses["500"] = {
      description: "任务、审计日志或市场观测持久化失败；服务端会回滚当前执行的内存变更",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/Error" }
        }
      }
    };
  }
  if (method === "post" && path === "/api/prospect-agent-jobs/:id/retry") {
    responses["409"] = {
      description: "任务状态不能重试，或市场分析任务尚未到允许重试时间",
      content: {
        "application/json": {
          schema: {
            oneOf: [
              { $ref: "#/components/schemas/Error" },
              { $ref: "#/components/schemas/MarketAnalysisRequestError" },
              { $ref: "#/components/schemas/MarketAnalysisProviderError" }
            ]
          }
        }
      }
    };
    responses["429"] = {
      description: "市场分析数据源仍处于限流冷却期，请在 retryAfterAt 后重试",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/MarketAnalysisProviderError" }
        }
      }
    };
    responses["502"] = {
      description: "市场分析重试调用上游数据源失败",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/MarketAnalysisProviderError" }
        }
      }
    };
    responses["504"] = {
      description: "市场分析重试调用上游数据源超时",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/MarketAnalysisProviderError" }
        }
      }
    };
  }
  if (method === "post" && path === "/api/prospect-agent-jobs/:id/cancel") {
    responses["409"] = {
      description: "任务状态不能取消；同步运行中的市场分析请求不能被伪装成已中断"
    };
  }
  if (method === "get" && path === "/api/prospect-campaigns/:id/trade-observations") {
    responses["200"] = {
      description: "返回当前登录人对此兼容项目引用拥有的当前持久化宏观贸易观测集合",
      content: {
        "application/json": {
          schema: tradeObservationListResponseSchema
        }
      }
    };
    responses["400"] = {
      description: "筛选参数错误，或 cursor 无效、过期、被篡改或不属于当前查询",
      content: {
        "application/json": {
          schema: {
            oneOf: [
              { $ref: "#/components/schemas/Error" },
              { $ref: "#/components/schemas/TradeObservationListRequestError" }
            ]
          }
        }
      }
    };
    responses["500"] = {
      description: "服务端无法读取或校验贸易观测列表",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/Error" }
        }
      }
    };
  }
  if (method === "get" && path === "/api/prospect-campaigns/:id/market-opportunities") {
    responses["200"] = {
      description: "返回当前登录人名下、由最近一次计算事件或显式历史批次选定的不可变市场机会事实快照",
      content: {
        "application/json": {
          schema: marketOpportunityListResponseSchema
        }
      }
    };
    responses["400"] = {
      description: "筛选参数错误，或 cursor 无效、过期、被篡改或不属于当前账号、项目、批次及查询",
      content: {
        "application/json": {
          schema: {
            oneOf: [
              { $ref: "#/components/schemas/Error" },
              { $ref: "#/components/schemas/MarketOpportunityListRequestError" }
            ]
          }
        }
      }
    };
    responses["404"] = {
      description: "显式 batchId 不存在，或不属于当前登录人的团队、负责人和项目范围",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/MarketOpportunityListRequestError" }
        }
      }
    };
    responses["500"] = {
      description: "服务端无法完成持久化读取屏障或读取事实快照",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/Error" }
        }
      }
    };
  }
  return responses;
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
      ...((
        route.path.startsWith("/api/organization-identity-conflicts")
      )
        ? {
            description: [
              "仅同团队 manager 和 admin 可读取及处理；sales、super_admin 和跨团队访问均不会获得额外数据。",
              "冲突原始事实永久保留为 open，人工结论与规范企业映射使用只追加记录，历史候选、身份事件、来源绑定、证据和 CRM 对象均不会被改写。",
              "merge 只建立冲突内企业到规范企业的映射；网站候选读取时投影规范 organizationId，不自动创建或合并线索、客户、商机、待办和网站商机。",
              "POST 必须携带列表返回的 If-Match；同一冲突只允许形成一次不可覆盖的人工结论。"
            ].join("\n\n")
          }
        : (
        route.path.startsWith("/api/organizations")
        || route.path.startsWith("/api/organization-relations")
      )
        ? {
            description: [
              "企业别名和集团关系是当前团队共享的证据事实，不是 CRM 客户资料；sales 可读取，只有同团队 manager 和 admin 可写入，super_admin 不穿透团队。",
              "母公司、最终母公司、分支、品牌和关联关系只建立关系图，不会把不同法定主体合并；层级关系执行目标冲突和循环检测。",
              "所有写入携带来源、证据摘要、观察时间、操作者和完整性哈希；重复事实幂等返回，不自动创建或修改线索、客户、商机、待办和网站商机。"
            ].join("\n\n")
          }
        : (
        route.path === "/api/prospect-strategies/:id/runs"
        || route.path.startsWith("/api/prospect-runs")
      )
        ? {
            description: [
              "Search Run Control Plane v1 只管理可审计的搜索执行意图，不调用任何 Provider，不产生 Raw Records、候选客户、线索、客户、商机、搜索数量、成本或成交金额。",
              "响应固定声明 executionMode=control_plane_only_v1、executionAvailable=false、hasExecutionData=false；queued 只表示已持久化排队意图，不表示后台任务正在运行。",
              "创建要求 Strategy If-Match 与 Idempotency-Key。幂等键原文不会落库；完全相同请求重放返回当前 Run，复用同一键提交不同请求返回 409。",
              "状态机严格限定 queued -> paused/cancelled、paused -> queued/cancelled，cancelled 为终态。resume 会重新校验当前项目、策略、Provider 策略及当前负责人个人凭据。",
              "业务员只读取当前归自己负责项目的运行；经理和管理员读取本团队。项目转交后，历史已取消 Run 的可见性随项目当前负责人变化，Run 创建时 ownerId 保持不可变审计事实。",
              "列表固定按 createdAt DESC、id DESC 排序，cursor 绑定当前账号、角色、团队和全部筛选条件。详情不会暴露 teamId、幂等键、请求/快照哈希、凭据、Base URL、请求头、原始第三方错误、原始游标或检查点。"
            ].join("\n\n")
          }
        : route.path === "/api/prospect-campaigns/:id/market-analysis-runs"
        ? {
            description: [
              "以负责人隔离的项目引用执行宏观贸易市场分析。服务端生成的 pc_<UUID> 按正式项目校验；其他合法引用暂按 compat_v1 兼容处理。",
              "当前增量尚未提供正式项目 Strategy，因此正式项目会在执行前返回 CAMPAIGN_NOT_ACTIVE；兼容引用继续维持既有执行能力。",
              "当前执行模式为 inline_single_instance_v1：请求会同步等待 Provider 完成，同一进程内的同指纹并发请求共享一次执行。",
              "当前 retryMode 为 manual 且 autoRetryScheduled 为 false，不提供自动调度；失败后需使用任一已接受的原幂等键，或任务重试接口手动重跑。",
              "dead_letter 使用同一幂等键提交时返回原终态，只有任务重试接口会扩展尝试次数并重新执行。",
              "duplicate=true 表示本次请求解析到既有或并发共享的任务；resultScope=job_execution 表示结果计数属于底层任务执行，不表示每次重放都再次写入。",
              "Location 指向的任务 GET 只恢复任务状态；使用任一已接受的 Idempotency-Key 重放本 POST 可恢复完整 querySummary、observations 与执行计数。",
              "当前不承诺多实例之间的原子幂等；部署应保持该执行器单实例，或在后续版本引入分布式锁。",
              "us_census_trade 仅支持美国 reporter 842、单个 4 位 CTY_CODE、单个 2/4/6 位现行 HS 编码，以及连续 1 至 36 个月的月度查询。",
              "该接口只写市场观测与任务审计，不创建线索、客户或商机。"
            ].join("\n\n")
          }
        : route.path === "/api/prospects/:id/convert-to-lead"
          ? {
              description: [
                "只有当前登录业务员明确执行人工确认后，才会把本人范围内的合格候选客户转换或关联为线索。",
                "接口固定使用会话中的 teamId 和当前 userId，不能通过请求体替管理员、主管或其他业务员操作。",
                "转换要求当前、未过期的 approved_contactable 决策，且批准人、联系人、联系方式均属于当前登录业务员。",
                "create_new 创建一条本人线索；link_existing 只允许关联本人已有且未删除的线索。",
                "一个接口、一个幂等键、一个事务；幂等键原文不落库，完全相同请求重放不会产生重复记录。",
                "该操作不会创建客户、商机或网站商机，也不会自动触发后续业务动作。"
              ].join("\n\n")
            }
        : route.path === "/api/prospects/:id/convert-to-customer"
          ? {
              description: [
                "只有当前登录业务员明确执行人工确认后，才会把本人已关联线索的候选客户新建或关联为客户。",
                "接口固定使用会话中的 teamId 和当前 userId，不允许管理员或主管借请求体替其他业务员操作。",
                "服务端会验证候选客户、原 prospect_conversion 来源事件和线索三者属于同一可信获客来源链。",
                "create_new 只从线索继承必要业务字段，不复制或虚构开票、付款等客户主档；link_existing 不覆盖已有客户资料。",
                "一个接口、一个幂等键、一个事务；客户来源审计为只追加记录，完全相同请求重放不会产生重复数据。",
                "该操作不会创建商机、商机事件、待办或网站商机；后续推进仍由业务员明确操作。"
              ].join("\n\n")
            }
        : route.path === "/api/prospect-campaigns/:id/trade-observations"
          ? {
              description: [
                "读取当前登录人在指定项目引用下的当前持久化贸易观测集合，不再次调用 Provider。服务端生成的 pc_<UUID> 按正式项目校验；其他合法引用暂按 compat_v1 兼容处理。",
                "campaignScope 固定为 owner；经理、管理员和超级管理员也不会扩大为团队数据。正式项目不存在或不属于当前负责人时统一返回 404；任意合法但未使用的兼容引用返回 200 空数组。",
                "dataScope 固定为 country_trade_statistics：记录是国家、伙伴、商品和期间层面的宏观统计，不是企业、采购商、采购意向、推荐客户或销售线索。",
                "absenceMeaning=not_observed_not_zero：没有记录只表示当前没有匹配观测，不能推断贸易值为零或市场不存在。",
                "固定按 period DESC、不可变 createdAt DESC、id DESC 分页。cursor 绑定当前账号、项目引用、全部筛选和匹配数据集；数据新增或更新后旧 cursor 返回 400，应从第一页重新获取。",
                "total 是当前请求时应用权限和全部筛选、但尚未应用 cursor 的完整匹配数；pageCount 是当前页数量。",
                "列表只返回业务白名单字段，不返回 teamId、ownerId、rawRecordId、payloadHash、Provider 凭证、请求日志或其他运行人的命中信息。",
                "单次市场分析 Job 的完整执行结果和计数仍应使用已接受的 Idempotency-Key 重放 market-analysis-runs POST 获取。"
              ].join("\n\n")
            }
          : route.path === "/api/prospect-campaigns/:id/market-opportunities"
            ? {
                description: [
                  "读取当前登录人在指定项目引用下的不可变市场机会事实快照，不调用 Provider、不重新计算、不创建任务，也不写入业务数据。服务端生成的 pc_<UUID> 按正式项目校验；其他合法引用暂按 compat_v1 兼容处理。",
                  "campaignScope 固定为 owner；经理、管理员和超级管理员也只能读取自己名下的数据。跨团队、跨负责人或跨项目的显式 batchId 统一按 404 处理。",
                  "省略 batchId 时严格选择最近一次计算事件指向的批次，即使该批次数据不足也不会静默回退到更早的可用批次；lastMetricsReadyBatch 仅供界面明确展示历史参考。",
                  "事实口径固定为 un_comtrade、年度 IMPORT、完全一致的 classification 与 commodityCode，并在同一商品组内使用共同对比期。三年序列为 WORLD 伙伴代码 0，中国大陆份额使用伙伴代码 156。",
                  "报告进口额是国家贸易统计事实，不等同于消费市场规模、真实需求、采购预算、采购意向、企业名单、线索质量或成交概率；转口、保税贸易、本地产量和统计差异会影响解读。",
                  "scoringStatus 固定为 not_scored_v1；接口不输出评分、排序建议、TAM、市场规模、自动推荐，也不会自动创建线索、客户或商机。",
                  "响应只返回业务白名单字段。证据链不会暴露 teamId、ownerId、campaignId、payloadHash、rawRecordId、Provider 凭证或租户运行信息。",
                  "cursor 绑定当前账号、项目、所选批次和全部筛选条件；任何跨范围或跨筛选复用都会返回 400。"
                ].join("\n\n")
              }
        : {}),
      operationId: operationId(route.method, route.path),
      security: securityFor(route.method, route.path),
      parameters: pathParameters(route.path, route.method),
      requestBody: requestBodyFor(route.method, route.path),
      responses: responsesFor(route.method, route.path)
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
          },
          additionalProperties: false
        },
        MarketAnalysisRequestError: marketAnalysisRequestErrorSchema,
        MarketAnalysisProviderError: marketAnalysisProviderErrorSchema,
        TradeObservationListRequestError: tradeObservationListRequestErrorSchema,
        MarketOpportunityListRequestError: marketOpportunityListRequestErrorSchema,
        ProspectCampaignSnapshotInput: {
          type: "object",
          properties: {
            goal: { type: "string", maxLength: 1000 },
            products: { type: "array", maxItems: 100, items: { type: "string", maxLength: 200 } },
            markets: { type: "array", maxItems: 100, items: { type: "string", maxLength: 200 } },
            customerTypes: { type: "array", maxItems: 100, items: { type: "string", maxLength: 200 } },
            applicationScenarios: { type: "array", maxItems: 100, items: { type: "string", maxLength: 200 } },
            icpRules: { type: "array", maxItems: 100, items: { type: "string", maxLength: 200 } },
            exclusionRules: { type: "array", maxItems: 100, items: { type: "string", maxLength: 200 } },
            sourceProviderIds: {
              type: "array",
              maxItems: 100,
              items: { type: "string", maxLength: 80, pattern: "^[A-Za-z0-9._-]+$" }
            }
          },
          additionalProperties: false
        },
        ProspectStrategyQueryInput: {
          type: "object",
          properties: {
            keywordMode: {
              type: "string",
              enum: ["campaign_products", "specific"],
              default: "campaign_products"
            },
            positiveKeywords: {
              type: "array",
              maxItems: 100,
              items: { type: "string", maxLength: 200 }
            },
            synonyms: {
              type: "array",
              maxItems: 100,
              items: { type: "string", maxLength: 200 }
            },
            industryTerms: {
              type: "array",
              maxItems: 100,
              items: { type: "string", maxLength: 200 }
            },
            purchaseScenarioTerms: {
              type: "array",
              maxItems: 100,
              items: { type: "string", maxLength: 200 }
            },
            countryMode: {
              type: "string",
              enum: ["campaign_markets", "global", "specific"],
              default: "campaign_markets"
            },
            countries: {
              type: "array",
              maxItems: 100,
              items: { type: "string", maxLength: 200 }
            },
            languages: {
              type: "array",
              maxItems: 100,
              description: "空数组表示由各 Provider 使用默认语言。",
              items: { type: "string", maxLength: 200 }
            },
            customerTypeMode: {
              type: "string",
              enum: ["campaign_customer_types", "all", "specific"],
              default: "campaign_customer_types"
            },
            customerTypes: {
              type: "array",
              maxItems: 100,
              items: { type: "string", maxLength: 200 }
            },
            exclusionKeywords: {
              type: "array",
              maxItems: 100,
              items: { type: "string", maxLength: 200 }
            },
            exclusionDomains: {
              type: "array",
              maxItems: 100,
              description: "只填写域名；服务端会转为小写 ASCII，不接受协议、路径或端口。",
              items: { type: "string", maxLength: 253 }
            },
            timeWindow: {
              type: "object",
              properties: {
                mode: { type: "string", enum: ["all", "fixed"], default: "all" },
                from: { type: "string", format: "date" },
                to: { type: "string", format: "date" }
              },
              additionalProperties: false
            }
          },
          additionalProperties: false
        },
        ProspectStrategyProviderPlanItem: {
          type: "object",
          required: ["providerId"],
          properties: {
            providerId: {
              type: "string",
              maxLength: 80,
              pattern: "^[A-Za-z0-9._-]+$",
              description: "数据源目录中的 Provider code；同一策略内必须唯一。"
            },
            priority: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            pageLimit: { type: "integer", minimum: 1, maximum: 100, default: 1 },
            resultLimit: { type: "integer", minimum: 1, maximum: 1000, default: 30 },
            budgetLimit: {
              type: "number",
              minimum: 0,
              maximum: 1000000,
              nullable: true,
              default: null
            },
            currency: {
              type: "string",
              pattern: "^(?:|[A-Z]{3})$",
              description: "设置预算时必填；无预算时为空字符串。"
            }
          },
          additionalProperties: false
        },
        ProspectCampaignError: {
          type: "object",
          required: ["message", "errorCode"],
          properties: {
            message: { type: "string" },
            errorCode: { type: "string" },
            missingFields: { type: "array", items: { type: "string" } },
            issues: {
              type: "array",
              items: { type: "object", additionalProperties: true }
            },
            duplicateStrategyId: { type: "string" },
            revision: { type: "integer" },
            etag: { type: "string" }
          },
          additionalProperties: false
        },
        ProspectRunError: {
          type: "object",
          required: ["message", "errorCode"],
          properties: {
            message: { type: "string" },
            errorCode: { type: "string" },
            issues: {
              type: "array",
              items: { type: "object", additionalProperties: true }
            },
            revision: { type: "integer" },
            etag: { type: "string" },
            runId: { type: "string" },
            campaignId: { type: "string" }
          },
          additionalProperties: false
        },
        ProspectRunDetailResponse: {
          type: "object",
          required: [
            "contractVersion",
            "executionMode",
            "executionAvailable",
            "hasExecutionData",
            "run",
            "shards",
            "events"
          ],
          properties: {
            contractVersion: {
              type: "string",
              enum: ["search_run_control_plane_v1"]
            },
            executionMode: {
              type: "string",
              enum: ["control_plane_only_v1"]
            },
            executionAvailable: { type: "boolean", enum: [false] },
            hasExecutionData: { type: "boolean", enum: [false] },
            idempotencyReplayed: { type: "boolean" },
            teamDuplicateAssociation: {
              type: "object",
              nullable: true,
              additionalProperties: true
            },
            run: {
              type: "object",
              required: [
                "id",
                "campaignId",
                "campaignVersion",
                "strategyId",
                "ownerId",
                "status",
                "revision",
                "createdBy",
                "createdAt",
                "updatedAt"
              ],
              properties: {
                id: { type: "string", pattern: "^pr_[0-9a-fA-F-]{36}$" },
                campaignId: { type: "string" },
                campaignVersion: { type: "integer", minimum: 1 },
                strategyId: { type: "string" },
                ownerId: { type: "string" },
                status: {
                  type: "string",
                  enum: ["queued", "paused", "cancelled"]
                },
                revision: { type: "integer", minimum: 1 },
                parentRunId: { type: "string", nullable: true },
                createdBy: { type: "string" },
                createdAt: { type: "string", format: "date-time" },
                updatedAt: { type: "string", format: "date-time" },
                pausedAt: { type: "string", format: "date-time", nullable: true },
                cancelledAt: { type: "string", format: "date-time", nullable: true },
                executionSnapshot: {
                  type: "object",
                  description: "创建时冻结的非敏感项目、策略、解析查询和 Provider 计划；不包含快照哈希或凭据。",
                  additionalProperties: true
                }
              },
              additionalProperties: false
            },
            shards: {
              type: "array",
              items: {
                type: "object",
                description: "Provider 控制分片；hasCursor 仅表示是否存在内部游标，不返回游标值。",
                additionalProperties: true
              }
            },
            events: {
              type: "array",
              items: {
                type: "object",
                description: "按 sequence 正序返回的追加式生命周期审计事件。",
                additionalProperties: true
              }
            }
          },
          additionalProperties: true
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

/**
 * GoodJob CRM API 入口。
 *
 * - server-core.ts：应用实例、全局中间件/权限闸、共享辅助函数与运行时状态
 * - routes/*.ts：按业务域拆分的路由，下方按原 server.ts 的顺序注册
 *
 * Express 按注册顺序匹配路由：调整注册顺序前先确认不同模块之间没有路径重叠。
 */
import { app, startServer } from "./server-core.js";
import { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { EngineUnavailableError } from "./ai-engine-service.js";
import { MysqlDataImportError } from "./mysql-data-import.js";
import { registerSwagger } from "./swagger.js";
import { registerCommunicationRoutes } from "./routes/communication.js";
import { registerProspectListRoutes } from "./routes/prospect-list.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerMailRoutes } from "./routes/mail.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerOutreachRoutes } from "./routes/outreach.js";
import { registerDealsRoutes } from "./routes/deals.js";
import { registerWorkspaceRoutes } from "./routes/workspace.js";
import { registerIamRoutes } from "./routes/iam.js";
import { registerCustomersRoutes } from "./routes/customers.js";
import { registerAiEngineRoutes } from "./routes/ai-engine.js";
import { registerLeadsRoutes } from "./routes/leads.js";
import { registerCommissionRoutes } from "./routes/commission.js";
import { registerKbRoutes } from "./routes/kb.js";
import { registerExchangeRoutes } from "./routes/exchange.js";
import { registerKnowledgeExamsRoutes } from "./routes/knowledge-exams.js";
import { registerTradeDocumentsRoutes } from "./routes/trade-documents.js";
import { registerToolsRoutes } from "./routes/tools.js";
import { registerOrganizationsRoutes } from "./routes/organizations.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerOrdersRoutes } from "./routes/orders.js";
import { registerFilesRoutes } from "./routes/files.js";
import { registerLeadFinderRoutes } from "./routes/lead-finder.js";
import { registerProspectingRoutes } from "./routes/prospecting.js";
import { registerReportsRoutes } from "./routes/reports.js";

registerCommunicationRoutes(app);
registerProspectListRoutes(app);
registerSystemRoutes(app);
registerMailRoutes(app);
registerAuthRoutes(app);
registerOutreachRoutes(app);
registerDealsRoutes(app);
registerWorkspaceRoutes(app);
registerIamRoutes(app);
registerCustomersRoutes(app);
registerAiEngineRoutes(app);
registerLeadsRoutes(app);
registerCommissionRoutes(app);
registerKbRoutes(app);
registerExchangeRoutes(app);
registerKnowledgeExamsRoutes(app);
registerTradeDocumentsRoutes(app);
registerToolsRoutes(app);
registerOrganizationsRoutes(app);
registerAgentRoutes(app);
registerOrdersRoutes(app);
registerFilesRoutes(app);
registerLeadFinderRoutes(app);
registerProspectingRoutes(app);
registerReportsRoutes(app);

registerSwagger(app);

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof MysqlDataImportError) {
    res.status(error.status).json({ message: error.message });
    return;
  }
  // 本机 CLI 不可用是「可恢复的执行环境问题」，不是服务器故障：
  // 必须把原因和 code 原样回给前端，否则用户只看到「服务器处理请求失败」，不知道该去起 Runner 还是换来源。
  if (error instanceof EngineUnavailableError) {
    res.status(error.status).json({ message: error.message, code: error.code, engineUnavailable: true });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ message: "参数格式错误", issues: error.issues });
    return;
  }
  if (typeof error === "object" && error && "type" in error && error.type === "entity.too.large") {
    res.status(413).json({ message: "请求内容过大" });
    return;
  }
  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({ message: "JSON 格式不正确" });
    return;
  }
  if (typeof error === "object" && error && "status" in error) {
    const status = Number(error.status);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      res.status(status).json({ message: error instanceof Error ? error.message : "请求被拒绝" });
      return;
    }
  }
  if (process.env.NODE_ENV !== "test") console.error(error);
  res.status(500).json({ message: "服务器处理请求失败" });
});

if (process.env.NODE_ENV !== "test") {
  void startServer();
}

export {
  app,
  setBusinessCardRecognizerForTest,
  setOutboundEmailDispatchObserverForTest,
  normalizeCrmCompanyName,
  isSameProviderOpportunity
} from "./server-core.js";

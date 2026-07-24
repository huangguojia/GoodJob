# WhatsApp CRM Plugin

独立运行的 WhatsApp CRM 接入插件，统一承载免费非官方通道与 Meta 官方通道，并为后续真实 CRM Adapter 保留稳定接口。当前版本定位为：

> 单租户、单实例、私网部署的生产候选版。

## 当前能力

- `baileys`：二维码登录、加密 AuthState、断线重连、多账号、联系人增量、实时双向文本和状态回执。该通道基于 WhatsApp Web，不是 Meta 官方 API。
- `meta`：Meta App/号码配置、Graph 归属校验、Webhook 验证与签名校验、入站文本、状态回执、24 小时窗口和已审核模板。
- `free_first`、`official_first`、`hybrid` 三种接入策略。策略只影响新账号推荐，不迁移、合并、登出或删除已有账号。
- 账号级联系人、会话、消息和幂等隔离；支持手动添加、WhatsApp 增量同步、CRM Sandbox 导入及可选自动建档。
- OpenAI 兼容 AI Provider；支持自动翻译开关和逐条手动翻译，原文与译文分开保存。
- React 运维控制台，覆盖账号、会话、联系人、路由、接入设置、AI 和诊断，并适配桌面、平板与移动端。
- 本机使用 PGlite，生产运行时强制 PostgreSQL。

Demo 数据和模拟 Provider 默认关闭。正常启动不会创建 Demo 账号、Mock AI Provider 或样例消息。

## 本地运行

要求 Node.js 20 或更高版本：

```bash
cp .env.example .env
npm install
npm run dev
```

- 独立控制台：<http://127.0.0.1:5193/whatsapp-plugin/>
- GoodJob CRM 内嵌入口：`/whatsapp-plugin/?embedded=1`
- 兼容健康检查：<http://127.0.0.1:3100/api/health>
- 存活检查：<http://127.0.0.1:3100/api/health/live>
- 就绪检查：<http://127.0.0.1:3100/api/health/ready>

如本机不能直连 WhatsApp Web，需要启用可访问 WhatsApp Web 与 WebSocket 的 TUN，或只为 Baileys 配置 HTTP(S) CONNECT 代理：

```dotenv
BAILEYS_PROXY_URL=http://127.0.0.1:7897
```

`.data/` 和 `.env` 已加入 `.gitignore`。本机加密主密钥与数据库必须配套备份，禁止输出到日志、文档或提交记录。

## 数据生命周期

系统初始化、演示注入和演示清理是三条独立路径：

```bash
npm run db:migrate
npm run db:init
```

只有需要隔离测试数据时，才临时设置 `ALLOW_DEMO_PROVIDER=true` 并显式执行：

```bash
npm run db:seed-demo
```

清理库必须已经由独立的 `db:migrate` 步骤迁移完成。清理命令自身不会修改 Schema；必须先 dry-run，再使用本次计划摘要提交：

```bash
npm run db:cleanup-demo
npm run db:cleanup-demo -- --apply --plan-digest=<本次 dry-run 摘要>
```

清理器使用事务、目标计数、计划摘要和保护数据摘要，只删除 Demo 账号及其级联数据、纯 Demo 路由/CRM Sandbox 数据，以及未被真实数据引用的 Mock Profile。路由若同时引用真实与 Demo 账号，清理会整单拒绝并要求先人工调整。不要直接删除整个 `.data/`。

## 生产约束

生产环境至少需要：

```dotenv
NODE_ENV=production
DATABASE_CLIENT=postgres
DATABASE_URL=postgresql://app@database.example/whatsapp_crm
SESSION_MASTER_KEY=<Base64 编码的 32 字节密钥>
SEED_DEMO=false
ALLOW_DEMO_PROVIDER=false
AUTO_MIGRATE=false
WEB_ORIGIN=https://crm.example.com
```

发布时先独立执行 `npm run db:migrate`，再启动唯一应用实例。生产构建会由同一 Express 进程提供 `dist/` 前端文件。

当前尚未实现登录鉴权/RBAC、`tenant_id`、Socket ACL/账号房间、持久 Inbox/Outbox、持久任务队列、多实例账号租约、Socket.IO 多实例 Adapter 和真实 CRM Adapter，因此不得把管理页面、REST API 或 Socket.IO 直接暴露到公网。Meta Webhook 只能通过 HTTPS 网关选择性公开对应路径。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

自动化测试覆盖配置 fail-closed、数据迁移与精准清理、API 账号隔离、翻译、CRM 建档、路由、Meta Mock Graph 契约、健康检查和优雅关闭。自动化通过不等于真实渠道通过；正式扩展前仍需使用目标 PostgreSQL、真实 Meta 测试资产和两个隔离 Baileys 账号完成端到端验收。

## 文档

- [架构说明](./docs/ARCHITECTURE.md)
- [生产部署与运维](./docs/PRODUCTION_DEPLOYMENT.md)
- [开发进度与本机验收](./开发进度与本机验收.md)
- [界面设计规范](./DESIGN.md)
- [第三方组件说明](./THIRD_PARTY_NOTICES.md)

## 许可证

本 Communication 服务使用 GPL-3.0-only，允许商业使用、修改和销售；分发
本服务或其修改版时，必须保留 GPL 声明并提供对应源代码。Baileys、libsignal
等上游组件仍分别适用其自身许可证，详见
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

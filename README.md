# GoodJob CRM 外贸客户管理软件原型交付

## WhatsApp 集成

CRM 的 `WhatsApp` 页面加载仓库内的独立服务 `whatsapp-plugin/`。该目录从已验收的
`桌面/GoodJob/CRM系统对接` 迁入，保留 Baileys/Meta Provider、PGlite/MySQL、
AES-256-GCM AuthState、Socket.IO、AI 翻译、测试和部署文档，不使用 CRM 原有的
`whatsapp-web.js` 页面作为聊天入口。

首次拉取后分别安装依赖：

```bash
npm install
npm --prefix whatsapp-plugin install --workspaces=false
npm run dev
```

默认地址：CRM `http://127.0.0.1:5188/`，WhatsApp 插件前端
`http://127.0.0.1:5193/whatsapp-plugin/`，插件 API `http://127.0.0.1:3100/`。
根目录的 `build` 和 `test` 会同时验证 CRM 与 WhatsApp 插件。

本机迁移数据位于 `whatsapp-plugin/.data/`，其中数据库和 `dev-master.key` 必须成对备份，
不得提交；生产环境必须按 `whatsapp-plugin/docs/PRODUCTION_DEPLOYMENT.md` 与 CRM 共用 MySQL、
固定 `SESSION_MASTER_KEY`，并在 CRM 鉴权网关后发布。当前插件是单租户、单实例、私网部署边界。

第三方组件归属见 `whatsapp-plugin/THIRD_PARTY_NOTICES.md`。

## 1. 产品定位

GoodJob CRM 是一款面向外贸销售团队的网页版客户管理软件，采用前后端分离架构，后端数据本地化存储到 MySQL。产品核心不是“记录客户”，而是让外贸业务员每天知道：该跟谁、跟进到哪一步、哪些客户有风险、哪些商机最可能成交、团队的数据是否可导入导出和沉淀。

参考方向来自主流 CRM 的共性能力：

- HubSpot CRM 强调联系人、交易、任务、邮件追踪和会议等易上手工作流。
- Pipedrive 强调可视化销售管道、活动跟进、目标和报表。
- Salesforce Sales Engagement 强调销售节奏、活动结果和 ROI 报表。
- Zoho CRM 强调导入、导出、报表格式和多渠道集成。

参考资料：

- HubSpot CRM: https://www.hubspot.com/products/crm
- Pipedrive 产品与报表: https://www.pipedrive.com/en/products, https://www.pipedrive.com/en/features/insights-and-reports
- Salesforce Sales Engagement Reports: https://help.salesforce.com/s/articleView?id=sales.hvs_reports_reports_dashboards_overview.htm&type=5
- Zoho CRM 导入/导出: https://help.zoho.com/portal/en/kb/crm/data-administration/import-data/articles/import-data, https://help.zoho.com/portal/en/kb/crm/faqs/data-administration/export/articles/faqs-exporting-data-from-zoho-crm

## 2. 目标用户与关键场景

目标用户：

- 外贸业务员：每天处理询盘、报价、样品、谈判、回访。
- 销售主管：看团队进度、客户分布、成交预测和逾期跟进。
- 运营/管理者：需要导入历史客户、导出经营数据、审计数据权限。

关键场景：

- 新线索从展会、官网、阿里国际站、海关数据或表格导入进入客户池。
- 业务员按国家、等级、采购意向、上次联系时间筛选客户。
- 系统自动提醒跟进逾期、报价后未回复、样品寄出后待确认。
- 跟进时可记录邮件、电话、企微聊天摘要和附件。
- 主管在报表中查看销售漏斗、国家市场、业务员业绩、跟进健康度。

## 3. 信息架构

一级导航：

1. 工作台
2. 客户
3. 商机
4. 跟进提醒
5. 导入导出
6. 报表
7. 企业微信
8. 资料维护
9. 在线考试
10. 小工具
11. 系统设置

核心对象：

- 客户 Customer：公司、国家、行业、联系人、等级、归属人、标签、最近跟进。
- 联系人 Contact：姓名、职位、邮箱、电话、企微状态、语言。
- 商机 Deal：产品、金额、币种、阶段、预计成交日、赢率、下一步动作。
- 跟进 Activity：类型、内容、时间、下一次提醒、附件、企微会话引用。
- 导入任务 ImportJob：文件、字段映射、去重规则、错误行、执行人。
- 导出任务 ExportJob：范围、格式、权限、水印、审计记录。
- 资料 KnowledgeAsset：类目、标题、版本、文件类型、审核状态、适用市场、权限。
- 题库 ExamQuestion：题型、题干、选项、答案、解析、产品类目、难度。
- 考试 Exam：类目、试卷、及格线、限时、参考人员、补考规则、成绩。

## 4. 页面原型说明

### 4.1 工作台

核心组件：

- 今日待办：逾期、今日、未来 7 天分组。
- 管道总览：询盘、已联系、已报价、样品、谈判、成交。
- 重点客户：高意向、长时间未跟、报价后未回。
- 快捷动作：新增客户、导入客户、导出报表、同步企微。

设计原则：

- 首页不做营销风大屏，做高密度工作台。
- 关键提醒放在第一屏左上，减少业务员找任务成本。
- 指标卡使用轻量色彩区分优先级，避免整页单色。

### 4.2 客户管理

核心组件：

- 高级筛选：国家、阶段、等级、业务员、标签、上次跟进区间。
- 客户表格：公司、国家、联系人、阶段、金额、最近跟进、下一提醒、企微状态。
- 侧边详情：基础信息、联系人、跟进时间线、商机、附件。
- 批量动作：分配、打标签、导出、设置提醒。

### 4.3 商机管道

核心组件：

- Kanban 阶段：询盘、已联系、已报价、样品、谈判、成交、丢单。
- 商机卡片：客户、金额、国家、下一动作、逾期状态。
- 拖拽变更阶段后要求填写阶段变更原因，便于报表复盘。

### 4.4 跟进提醒

核心组件：

- 日历视图与列表视图。
- 逾期规则：超过设定天数未跟进、报价后 N 天未回、样品寄出后 N 天待确认。
- 提醒渠道：站内、邮件、企业微信。

### 4.4.1 待办清单

核心组件：

- 快速新增待办：支持自然语言输入，如“明天 10 点跟进重点客户报价”。
- 筛选视图：今天、逾期、我负责、客户跟进、资料/考试。
- 任务字段：优先级、截止时间、负责人、关联客户/商机/资料/考试/OCR 线索、子任务进度。
- 任务状态：未完成、已完成、逾期、高影响金额。
- 待办洞察：今日待办、逾期数量、完成率、高影响金额、任务类型分布和周日历热度。

### 4.5 导入导出

核心组件：

- 导入向导：上传、字段映射、去重预览、错误修正、确认导入。
- 导出中心：客户、联系人、跟进、商机、报表，支持 CSV/XLSX/PDF。
- 审计：导出人、时间、字段范围、审批状态。

### 4.6 报表

核心组件：

- 销售漏斗：阶段客户数、金额、转化率。
- 国家/地区分布：重点市场成交与询盘对比。
- 跟进健康度：逾期率、平均响应时长、报价未回复。
- 团队排行：新增客户、有效跟进、成交额、预测金额。

### 4.7 企业微信

核心组件：

- 客户企微绑定状态。
- 会话摘要归档到客户时间线。
- 提醒推送到业务员企微。
- 敏感字段脱敏和管理员授权。

### 4.8 数据本地化与系统设置

核心组件：

- MySQL 连接状态、备份计划、字段字典。
- 角色权限：业务员、主管、管理员、只读财务。
- 数据保留与导出审批。

### 4.9 资料维护

核心组件：

- 产品知识类目：产品线、认证资料、报价规则、包装物流、销售 SOP。
- 资料库：支持 PDF、Word、Excel、图片、视频、链接，保留版本与审核记录。
- 资料标签：适用市场、产品线、客户阶段、权限范围。
- 审核流：新资料或新版本必须经过负责人审核后发布。
- 考试关联：资料更新后可自动触发对应类目复训或抽考。

### 4.10 销售在线考试系统

核心组件：

- 在线考试：单选、多选、判断、问答，支持限时、自动判分、错题解析。
- 分类目考试维护：按产品知识类目维护考试，如 LED 灯具、认证资料、报价规则、包装物流。
- 题库维护：题型、难度、答案、解析、适用岗位、资料引用。
- 成绩统计：按团队、人员、类目、通过率、均分分析。
- 补考提醒：未参加或未通过自动推送企微提醒。

### 4.11 小工具

核心组件：

- 名片 OCR 识别：上传或加载名片，解析公司名、联系人、职位、邮箱、WhatsApp、微信、电话、国家、城市、标签。
- 字段复核：识别结果可编辑，可勾选需要同步的字段。
- 去重检查：按公司名、邮箱域名、电话、WhatsApp 做重复线索检查。
- 同步线索：确认后同步到线索池，并可指定团队、来源、初始阶段和下一步动作。
- 后续工具预留：汇率换算、客户去重、跟进话术生成、HS 编码速查。

## 5. 功能自我辩论与最终取舍

| 功能 | 支持理由 | 反对理由 | 专业结论 |
|---|---|---|---|
| 客户跟进进度提醒 | 外贸销售周期长，报价和样品节点容易丢；提醒能直接减少遗忘损失 | 过多提醒会让业务员麻木 | 必做。默认只提醒高价值、逾期、报价后未回三类，允许个人自定义频率 |
| 导入导出 | 外贸团队历史客户多，Excel 迁移是上线门槛；导出是经营分析刚需 | 导出可能带来数据泄露 | 必做。导入开放，导出按角色、字段、审批和水印控制 |
| 美观报表 | 主管需要快速看市场、漏斗和团队效率 | 早期数据不完整时报表可能误导 | 必做但分层。先做漏斗、跟进健康度、国家分布，后续再做预测模型 |
| 沟通企业微信 | 国内团队高频使用企微，提醒触达率高 | 外贸客户未必使用企微，且接口权限有门槛 | 必做团队侧企微，不把它当海外客户唯一沟通工具；先做提醒和会话归档 |
| 数据本地化 MySQL | 满足企业私有化、可审计、可备份诉求 | 运维成本高于纯 SaaS | 必做。采用本地 MySQL + 标准备份 + 操作审计 |
| 资料维护 | 外贸销售强依赖产品参数、认证资料、报价话术，资料不统一会直接影响转化 | 如果只做文件夹，会变成网盘，价值不高 | 必做。资料必须类目化、版本化、审核化，并能关联考试 |
| 销售在线考试 | 产品知识复杂，新人培训和老销售复训需要量化结果 | 考试可能增加销售负担 | 必做但要轻量。按产品类目短考试，错题反推资料维护和复训 |
| OCR 名片识别小工具 | 展会和拜访场景名片多，手工录入慢且容易错 | OCR 识别可能有误，需要人工复核 | 必做为小工具。识别后必须可编辑、可勾选、可去重，再同步到线索 |
| 待办清单 | 销售每天跨客户、资料、考试、线索处理多个任务，需要统一入口 | 如果只是普通列表，会变成另一个提醒页 | 必做。必须放首页，并支持优先级、关联业务对象、筛选、负责人、进度和洞察 |
| 自动 AI 客户评分 | 可提升线索优先级 | 首版数据样本不足，容易误判 | 暂不作为 MVP 核心。先用规则评分，保留 AI 字段扩展 |
| 全渠道邮件收发 | 外贸邮件非常关键 | 邮箱协议和送达率复杂，首版容易拖慢进度 | 首版记录邮件与附件，二期做邮箱深度同步 |
| 拖拽式自定义流程 | 不同行业销售阶段不同 | 太早开放会造成配置混乱 | 提供管理员阶段配置，但限制字段和状态数量 |

## 6. MVP 范围

必须上线：

- 登录与账号管理
- 角色权限与数据范围隔离：业务员仅本人数据，主管查看团队全部，管理员全量配置
- 登录与角色权限
- 工作台
- 客户列表与详情
- 商机管道
- 跟进提醒
- 待办清单：快速新增、优先级、截止时间、负责人、关联对象、完成状态
- Excel/CSV 导入导出
- 报表首页
- 企业微信提醒与会话摘要字段
- 资料维护：类目、资料库、版本、审核、权限
- 销售在线考试：题库、分类目考试、在线作答、成绩与补考
- 小工具：名片 OCR 识别、字段编辑、勾选同步线索
- MySQL 本地化存储

暂缓：

- AI 自动写跟进总结

## 7. 本地开发与验证

数据库首次拆分（只执行一次）：

```bash
cd GoodJob/CRM
npm run db:profiles:provision
```

该命令会先备份当前 `.env` 指向的数据库，再建立互相隔离的个人库、开发库和测试账号。
本地凭据分别写入 `.env.personal.local`、`.env.development.local` 和 `.env.test.local`，
这些文件禁止进入版本控制。

日常使用个人库：

```bash
npm run app:personal
```

开发时使用开发库：

```bash
npm run dev
```

`npm run dev` 固定等同于 `npm run app:dev`。每次启动都会校验数据库档位和数据库名；
个人档位只能连接 `goodjob_crm_personal`，开发档位只能连接 `goodjob_crm_dev`。

查看两套数据库的连接状态：

```bash
npm run db:profiles:status
```

分别执行迁移：

```bash
npm run db:migrate:personal
npm run db:migrate:dev
```

运行隔离的 MySQL 集成测试：

```bash
npm run test:mysql
```

MySQL 测试必须使用 `.env.test.local` 中的 `MYSQL_TEST_ADMIN_URL`，测试用例只创建并删除
`goodjob_*_test_*` 随机临时库，不允许回退到个人库或开发库。

提交 SVN 前执行：

```bash
npm run svn:check-database
```

SVN 只保存 `backend/schema.mysql.sql`、迁移代码及程序内的虚构开发种子；
真实数据库、备份和 `.env.*.local` 均不得提交。

访问：

- 前端：http://127.0.0.1:5188/
- 个人档位后端：http://127.0.0.1:4188/
- 开发档位后端：http://127.0.0.1:4190/

MySQL 模式默认不会写入演示账号或演示业务数据。只有隔离的开发数据库需要演示数据时，才显式设置 `CRM_SEED_DEVELOPMENT_DATA=true`；不要在公测或生产数据库启用该开关。

智能获客 Worker 默认使用 MySQL 权威状态和轮询执行。服务器已安装 Redis 时，可选配置：

```bash
PROSPECT_EXECUTION_DB_LOCK_TIMEOUT_MS=5000
PROSPECT_CANDIDATE_DB_LOCK_TIMEOUT_MS=5000
REDIS_URL=redis://127.0.0.1:6379/0
PROSPECT_QUEUE_REQUIRED=false
PROSPECT_QUEUE_SYNC_MS=5000
```

执行内核的 Run、任务、租约、Ledger 和原始来源状态通过独立 MySQL 事务通道写入；每次事务先回读数据库权威状态，并使用 `PROSPECT_EXECUTION_DB_LOCK_TIMEOUT_MS` 控制数据库互斥锁等待上限。候选清洗结果通过另一条独立事务通道写入，每次先回读最新网站候选，并使用 `PROSPECT_CANDIDATE_DB_LOCK_TIMEOUT_MS` 控制互斥锁等待上限；该通道只写 `website_opportunities`，不会改动线索、客户、商机或待办。启用 Redis 后，BullMQ 只负责即时唤醒、延迟重试信号和死信镜像，Redis 不保存团队、业务员、查询条件、密钥或 Provider 原始数据。MySQL 仍是唯一业务事实来源；Redis 临时不可用时自动回退到原有轮询。只有要求 Redis 不可用就禁止启动时，才设置 `PROSPECT_QUEUE_REQUIRED=true`。

当前生产 Store 仍保持单后端实例约束：候选清洗管道、全局 Provider 限流和独立 Worker 生命周期尚未全部改造成跨进程原子路径，不能仅靠开启 Redis 或 MySQL 执行事务通道横向启动多个 API/Worker 进程。

### 外部工具集成（Stage 1-8）

集成中心默认关闭。启用只读 MCP 控制面时，API 与独立 Integration Worker 必须连接同一个 MySQL、Redis，并使用完全相同的凭据加密密钥：

```bash
INTEGRATION_ENABLED=true
INTEGRATION_WORKER_ENABLED=true
INTEGRATION_CREDENTIAL_KEY=请生成至少32位且独立保存的随机密钥
REDIS_URL=redis://127.0.0.1:6379/0
DATABASE_URL=mysql://用户名:密码@127.0.0.1:3306/goodjob_crm
INTEGRATION_AGENT_CALL_TIMEOUT_MS=30000
# OAuth 连接器启用时填写 CRM API 的公网 HTTPS 地址
INTEGRATION_OAUTH_CALLBACK_BASE_URL=https://api.example.com
INTEGRATION_WEBHOOK_BASE_URL=https://api.example.com
# 授权结束后返回集成中心的公网 HTTPS 地址
INTEGRATION_OAUTH_SUCCESS_REDIRECT_URL=https://crm.example.com/
# Microsoft 365 官方连接器；Tenant ID 也可以填写 Azure 租户 GUID
INTEGRATION_MICROSOFT_CLIENT_ID=Azure_应用_Client_ID
INTEGRATION_MICROSOFT_TENANT_ID=organizations
# 生产机建议配置，值只保存在服务器环境变量中
INTEGRATION_OAUTH_MICROSOFT_CLIENT_SECRET=Azure_应用_Client_Secret
# Google Workspace 官方连接器
INTEGRATION_GOOGLE_CLIENT_ID=Google_Cloud_OAuth_Client_ID
INTEGRATION_OAUTH_GOOGLE_CLIENT_SECRET=Google_Cloud_OAuth_Client_Secret
# ERPNext 固定实例地址；API Key/Secret 不写入环境文件，在集成中心按连接录入
INTEGRATION_ERPNEXT_BASE_URL=https://erp.example.com/
```

先启动 CRM API，再单独启动 Worker：

```bash
npm run start:mysql --workspace backend
npm run start --workspace integration-worker
```

开发环境可设置 `INTEGRATION_FAKE_MCP_URL=http://127.0.0.1:<端口>/mcp` 验证连接、发现、审核、授权和只读调用闭环。生产环境不会注册 Fake MCP，也不接受用户输入任意 MCP URL；正式连接器必须由服务端目录预置 HTTPS 地址和主机白名单。

Stage 2 OAuth 连接器使用 metadata discovery、256 bit state/nonce、PKCE S256 和一次性回调事务。授权码、PKCE verifier、access token 与 refresh token 不返回浏览器，全部以 AES-GCM 密文保存在 MySQL；Worker 每 5 分钟扫描 24 小时内到期的凭据，通过 MySQL 分布式锁刷新。`invalid_grant` 会立即把连接切换为“需重新授权”，解绑时优先调用授权服务器的 revocation endpoint。OAuth callback 必须由反向代理公开转发到 `/api/integrations/oauth/callback/:connectorCode`，该路由不要求 CRM 登录，但会校验一次性 state、connector、issuer、resource 和固定 redirect URI，并禁止 iframe 嵌入。

Stage 3 支持 R3-R5 写入工具。管理员审核时必须配置允许角色、字段白名单、数据分类、审批策略和完成证据；secret 字段及嵌套 secret 永远禁止外发。R4-R5 或 `always` 策略会先创建 10 分钟有效的冻结参数审批，批准操作以 MySQL 事务单次消费，重复批准不会重复入队。远端返回必须满足 `created_object_id`、`external_receipt_id`、`state_transition`、`read_after_write_match`、`delivery_acceptance` 或 `file_artifact` 中已声明的证据。写请求发出后发生网络中断时不会盲目重试，而是进入 `unknown_outcome`，由经理或管理员填写外部回执进行人工对账。审批、过期、授权失效和待对账状态会进入现有站内信铃铛。

Stage 4 提供 Microsoft 365 Outlook 邮箱和日历闭环。Azure 应用需要配置委托权限 `User.Read`、`Mail.Read`、`Mail.ReadWrite`、`Mail.Send`、`Calendars.ReadWrite` 和 `offline_access`，并将 Web 重定向 URI 精确设置为 `https://你的CRM域名/api/integrations/oauth/callback/microsoft-365`。回调基础地址只填写域名，不附加 `/api` 路径。邮件发送、会议创建和会议更新均使用冻结参数审批；CRM 客户 ID 只用于本地关联，不发送给 Microsoft Graph。Stage 5 已加入 Microsoft Graph 实时订阅、Webhook 去重、死信和回放，生产发布前仍必须使用真实租户完成端到端验收。

Stage 7 提供 Google Workspace Gmail 与 Google Calendar 官方连接器。Google Cloud OAuth Web 应用必须启用 Gmail API 和 Google Calendar API，并将重定向 URI精确设置为 `https://你的CRM域名/api/integrations/oauth/callback/google-workspace`。授权范围包括 Gmail 读取、草稿与发送，以及日历事件和忙闲查询；发送邮件、创建会议和更新会议沿用 R4 冻结参数审批与 CRM 客户回写。涉及 Gmail 敏感/受限范围时，公测前还需按 Google 要求完成 OAuth consent screen、测试用户或应用验证。依赖 Google Cloud Pub/Sub 的 Gmail 实时推送仍需单独配置，Client ID 与 Client Secret 未同时配置时目录会保持规划态。

Stage 8 增加 ERPNext、EasyPost 国际物流和 Google Drive 贸易单据三个官方连接器。ERPNext 仅调用 `INTEGRATION_ERPNEXT_BASE_URL` 指向实例的 Frappe REST API；EasyPost 仅调用 `api.easypost.com/v2`，不会抓取承运商网站；二者的 API 凭据在连接弹窗录入，以 `teamId + ownerId + connectionId` 作为 AES-GCM 绑定后保存，接口和日志不回显。Google Drive 使用最小化的 `drive.file` Scope，只管理 GoodJob CRM 创建的文件；Google Cloud 项目需启用 Drive API，并额外登记重定向 URI `https://你的CRM域名/api/integrations/oauth/callback/google-drive-trade-docs`。报价/订单创建、物流跟踪创建、文件上传和对外共享沿用现有审批、参数冻结、完成证据与未知结果人工对账。正式发布前仍需分别使用企业自己的 ERPNext、EasyPost 和 Google Workspace 账号完成真实实例验收。

Stage 9 增加企业微信官方 API 连接器。管理员在集成中心创建团队连接时录入 `CorpID`、自建应用 `Secret`、`AgentId` 和“客户联系 Secret”；四项凭据按连接加密保存，换密钥后旧 access token 会失效，access token 只在 Integration Worker 内存中短期缓存。连接器只访问 `qyapi.weixin.qq.com` 的固定官方接口，提供部门、成员、外部联系人编号、外部联系人详情和应用文本通知 5 个工具，不访问企业或客户网页。成员列表默认不返回手机号和邮箱；应用通知禁止 `@all`，最多 100 名明确成员，启用 30 分钟重复消息检查，并经过 R4 冻结参数审批。部署前需在企业微信管理后台创建自建应用、配置可见范围和服务器可信 IP，并从“客户联系 API”页面获取独立 Secret；正式开放前仍需使用真实企业完成最小权限、成员读取、客户读取、消息回执、换密钥和解绑验收。

开发环境可额外设置 `INTEGRATION_FAKE_OAUTH_MCP_URL`、`INTEGRATION_FAKE_OAUTH_CLIENT_ID`、`INTEGRATION_FAKE_OAUTH_APPROVED_HOSTS` 和 `INTEGRATION_FAKE_OAUTH_SCOPES` 注册 OAuth 测试连接器；这些配置在生产环境不会生效。

Stage 1 只开放 R0-R2 只读工具。Agent 只能通过管理员审核后的稳定别名调用，成功结果必须携带 `source` 和 `observedAt`；Redis 队列只传调用 ID，输入与结果以 AES-GCM 密文保存在 MySQL。

生产环境还必须配置至少 32 位的独立密钥：

- `PROVIDER_CREDENTIAL_KEY`：加密自动搜客数据源连接密钥。
- `TRADE_OBSERVATION_CURSOR_SECRET`：签名贸易观测列表分页游标。
- `MARKET_OPPORTUNITY_CURSOR_SECRET`：签名市场机会事实列表分页游标。
- `ORGANIZATION_IDENTITY_MASTER_SECRET`：派生企业强身份处理、查询、加密和完整性密钥。
- `PROSPECT_SOURCE_RAW_ENVELOPE_SECRET`：解密 Provider 原始记录信封。

以上密钥之间以及它们与 `JWT_SECRET` 之间都不要共用。一键部署脚本会分别生成并持久化；升级部署会优先沿用已有值，避免历史密文、完整性摘要或有效游标因服务重启而失效。

若未配置 MySQL，系统自动使用内存模式。健康检查：

```bash
curl http://127.0.0.1:4188/api/health
```

验证：

```bash
npm run build
npm run test
npm run test:e2e
```

页面级自动化测试覆盖登录、待办、客户、资料维护、在线考试、OCR 同步和经营汇报导出。
- 邮件完整双向同步
- 多语言前台
- 财务回款模块
- 移动端完整 App

## 7. 前后端分离建议

前端：

- React / Vue 均可，推荐 Vue 3 + TypeScript + Element Plus 或 React + TypeScript + Ant Design Pro。
- 状态管理：Pinia/Zustand。
- 图表：ECharts。
- 表格：支持列配置、固定列、批量操作、虚拟滚动。

后端：

- Java Spring Boot / NestJS 均可。
- API 风格：REST 优先，复杂报表可补充专用聚合接口。
- 权限：RBAC + 数据归属范围。
- 任务：导入导出走异步队列。

MySQL 核心表：

- users
- roles
- user_role_bindings
- data_scope_rules
- login_sessions
- customers
- contacts
- deals
- activities
- reminders
- todos
- todo_assignees
- todo_relations
- import_jobs
- export_jobs
- wecom_bindings
- knowledge_categories
- knowledge_assets
- knowledge_asset_versions
- exam_categories
- exam_questions
- exams
- exam_assignments
- exam_attempts
- exam_answers
- ocr_jobs
- ocr_extracted_fields
- audit_logs

关键接口：

- GET /api/dashboard/summary
- POST /api/auth/login
- POST /api/auth/logout
- GET /api/auth/me
- GET /api/accounts
- POST /api/accounts
- PATCH /api/accounts/{id}
- GET /api/roles
- GET /api/data-scope-rules
- GET /api/customers
- POST /api/customers/import
- POST /api/customers/export
- GET /api/deals/pipeline
- PATCH /api/deals/{id}/stage
- GET /api/reminders
- POST /api/reminders
- GET /api/todos
- POST /api/todos
- PATCH /api/todos/{id}
- POST /api/todos/{id}/complete
- GET /api/reports/funnel
- GET /api/reports/followup-health
- POST /api/wecom/sync-session-summary
- GET /api/knowledge/categories
- POST /api/knowledge/assets
- PATCH /api/knowledge/assets/{id}/publish
- GET /api/exams/categories
- POST /api/exams
- POST /api/exams/{id}/assign
- POST /api/exam-attempts
- POST /api/exam-attempts/{id}/submit
- GET /api/reports/exam-performance
- POST /api/tools/ocr/business-card
- PATCH /api/tools/ocr/jobs/{id}/fields
- POST /api/tools/ocr/jobs/{id}/sync-lead

### 7.1 Swagger API 调试

部署后访问：

```text
https://你的域名/api/docs/
```

Swagger 文档默认启用，但必须先使用管理员或超级管理员账号登录 CRM。未登录用户和普通业务员无法读取文档页面或 OpenAPI JSON。

- 页面入口：`/api/docs/`
- OpenAPI JSON：`/api/docs/openapi.json`
- 浏览器 Cookie 调试：自动携带登录会话，写请求自动附加 CSRF Token
- Bearer 调试：调用 `/api/auth/login` 取得 `token`，在 Swagger 的 Authorize 中填写
- 关闭文档：部署时设置 `ENABLE_API_DOCS=false`

生产环境不要绕过管理员限制，也不要将管理员 Token 或生产密码写入 Swagger 示例、代码或 SVN。

## 8. 可用性与美观确认

已按以下标准设计：

- 第一屏直接进入工作台，不做宣传页。
- 视觉风格克制、清爽、偏企业级，适合长时间办公。
- 主色使用深海蓝，辅助色使用绿色、琥珀、红色与中性色，避免单一色系。
- 表格、筛选、提醒、报表均为高频业务组件，减少装饰性卡片。
- 每个核心页面都有明确主动作：新增客户、导入、导出、同步企微、设置提醒。
- 逾期和高意向状态用颜色与标签双重表达，不只依赖颜色。
- 报表保留数字、趋势和解释维度，便于主管快速判断。
- 增加资料维护和在线考试后，首页加入知识与考试运营矩阵，让系统更密、更像真实业务后台。
- 登录后按账号角色加载数据范围：业务员只看本人客户/待办/线索，主管看团队全部，管理员看全量配置和审计。

## 9. 文件说明

- `frontend/index.html`：Vite 应用页面骨架，业务数据由后端接口加载。
- `README.md`：产品、功能辩论、架构与页面说明。

## 10. 开源许可证

GoodJob CRM 自有核心代码使用 Apache-2.0，允许使用、修改、商用、销售和
再分发，但必须保留许可证、版权和 NOTICE。Communication 是独立服务，因
运行时包含 GPL-3.0 的 libsignal，使用 GPL-3.0-only；它同样允许商用，但
分发时必须按 GPL 提供对应源代码并保留声明。

WhatsApp 相关上游项目、版本和许可证见
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。本项目不属于 Meta
或 WhatsApp 官方产品。

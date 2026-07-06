# GoodJob CRM 外贸客户管理软件原型交付

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

- 快速新增待办：支持自然语言输入，如“明天 10 点跟进 Nordic Tools 报价”。
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

启动：

```bash
cd GoodJob/CRM
npm run dev
```

访问：

- 前端：http://127.0.0.1:5188/
- 后端：http://127.0.0.1:4188/

启用 MySQL 持久化：

```bash
CRM_STORE=mysql DATABASE_URL="mysql://user:password@127.0.0.1:3306/goodjob_crm" npm run dev
```

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

- `index.html`：可直接打开的网页版交互原型。
- `figma-use-script.js`：用于 Figma MCP `use_figma` 的画布生成脚本。
- `README.md`：产品、功能辩论、架构与页面说明。

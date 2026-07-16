# GoodJob CRM 开发状态

## 智能获客重构进度（2026-07-14）

### 已完成：Campaign + Version 持久化

- 正式获客项目使用服务端生成的 `pc_<UUID v4>`。
- 草稿创建会原子生成项目、版本 1 和审计事件。
- 项目版本保存完整 ICP、排除规则、来源范围和内容哈希，版本及事件只允许追加。
- 项目修改使用 `If-Match` 和 revision 防止并发覆盖。
- 业务员本人、经理/管理员团队范围和超级管理员禁入边界已完成。
- 正式 `pc_` 项目与非 `pc_` 的 `compat_v1` 旧市场引用已完成分流。
- 已完成 MySQL 三张表、部署基线 SQL、冷启动恢复、失败回滚和命名空间校验。
- 已完成终态项目离职交接：禁止修改业务内容，但允许经理/管理员转交负责人。
- Campaign API、MySQL、安全、市场链路、Provider MySQL 和生产构建测试全部通过。
- 产品经理、外贸业务员、后端安全工程师最终复核均为 `APPROVE`。

### 已完成：Prospect Strategy 配置与审批

- 新建正式 Campaign 时，同一事务自动创建版本 1、默认 Strategy 草稿和连续审计事件。
- Strategy 固定绑定 Campaign 及不可变版本，支持草稿编辑、预览、审批和终态禁用。
- 关键词、国家和客户类型支持继承 Campaign、全局/不限或明确指定三类模式。
- Provider 计划只保存非敏感配置，按优先级稳定排序；审批和激活复用真实 Runtime 门禁。
- 所有 Strategy 写操作使用 `If-Match`；手工新增 Strategy 同时校验并推进 Campaign revision。
- Campaign 转交负责人时，全部 Strategy 负责人和 revision 在同一事务内同步更新。
- 激活 Campaign 前会重验当前版本全部已审批 Strategy、Provider 适配器和负责人个人凭据。
- Preview 只返回解析条件、重复指纹、校验问题和执行顺序，不伪造历史、游标、成本或净新增。
- 重复提示覆盖当前用户可见项目：业务员仅本人，经理/管理员仅本团队，跨团队不泄漏。
- MySQL 已增加 Strategy 与 append-only Event 表、版本外键、状态约束、指纹索引和连续事件链校验。
- Strategy API、MySQL 冷启动与回滚、安全隔离、Provider Runtime 和生产构建测试全部通过。
- 产品经理、外贸业务员、后端安全工程师修复复审后均为 `APPROVE`。

### 已完成：Search Run Control Plane v1

- 正式 Run 固定绑定 `campaignId + campaignVersion + strategyId`，并保存不可变执行快照。
- 当前仅实现运行控制面，不调用 Provider，不生成原始记录、候选企业、线索、客户或商机。
- 所有响应固定声明：
  - `executionMode = control_plane_only_v1`
  - `executionAvailable = false`
  - `hasExecutionData = false`
- 创建 Run 必须同时提供 Strategy `If-Match` 和 `Idempotency-Key`。
- 幂等键原文不落库，只保存服务端 HMAC；完全相同请求返回当前 Run，不同请求复用同一键返回 `409`。
- 活动唯一性固定为同团队、同负责人、同查询指纹最多一个 `queued` 或 `paused` Run。
- 状态机固定为：
  - `queued -> paused | cancelled`
  - `paused -> queued | cancelled`
  - `cancelled` 为终态
- Campaign 暂停会在同一事务中暂停全部 `queued` Run、Shard 并写入连续审计事件；重新激活不会自动恢复。
- 活动 Run 会阻止负责人转交、版本发布、项目完成/归档、Strategy 禁用和适用的账号删除。
- Run 负责人不可变；历史可见性跟随 Campaign 当前负责人和团队权限。
- 列表使用租户、角色和过滤条件绑定的 HMAC 签名游标；详情不返回内部哈希、原始游标或检查点。
- MySQL 已增加 `prospect_search_runs`、`prospect_run_shards`、`prospect_run_events`，并同步到 `schema.mysql.sql` 部署基线。
- 已完成复合外键、活动唯一索引、幂等唯一索引、CAS、append-only 事件、冷启动完整性和篡改检测。
- 最终复核发现并修复 Campaign 暂停/创建竞态、同实例幂等并发 500 和静态部署基线缺表。
- 新增确定性测试覆盖同键并发重放、异键同指纹竞争、Campaign 暂停/创建交错及静态基线导入。
- Run API、Campaign、Strategy、安全、MySQL、Provider MySQL、全功能回归和前后端生产构建全部通过。
- 高级产品经理、高级外贸业务员、后端安全工程师修复复审后均为 `APPROVE`。

### 已完成：Search Run Queue Bridge v1

- 每个新建 Run 会创建一条隐藏的 `prospect.orchestrate` 父 Job，每个 Shard 创建一条隐藏的 `prospect.provider.fetch` 子 Job。
- Queue Bridge 只把已经持久化的 Run/Shard 控制意图映射到任务图，不领取任务、不调用 Provider、不生成执行数据。
- 公开响应继续固定声明：
  - `executionMode = control_plane_only_v1`
  - `executionAvailable = false`
  - `hasExecutionData = false`
- 桥接 Job 使用保留任务类型，通用任务列表、详情、重试、取消、恢复和公开序列化入口均不可读取或操作。
- 父子 Job 只保存经过 AES-GCM 加密的最小载荷；团队、负责人、Run、Shard、父子关系和执行快照均参与完整性校验。
- 新增父、子桥接绑定表，使用 SHA-256 绑定哈希和六条 `RESTRICT` 外键约束 Job、Run、Shard 与父子绑定关系。
- 桥接 Job 幂等摘要会按服务端 HMAC 规则重新计算并精确比较，不能只凭摘要格式通过校验。
- `traceId` 固定为 `trace_<UUID v4>`；密文认证失败会转换为稳定的桥接完整性错误，Run API 返回 `409`。
- Run 与全部 Shard 状态必须一致；桥接 Job 按“非取消为 `queued`、取消为 `cancelled`”映射，Pause、Resume、Cancel 和 Campaign Pause 操作前后均校验完整任务图。
- 新 Run、精确幂等重放和读取操作均验证桥接图；MySQL 冷启动会进行双向孤儿、重复绑定、跨域引用和篡改检查。
- `queueBridgeVersion = null` 的历史 Run 保持原状，不隐式补图；如果历史 Run 被挂入 v1 绑定则拒绝启动。
- `schema.mysql.sql` 已同步桥接字段、两张绑定表、索引、检查约束和外键，可用于离线建库。
- Run、Campaign、Strategy、安全、真实 MySQL、Provider/缓存/贸易/市场回归、全功能测试和前后端生产构建全部通过。
- 高级产品经理、高级外贸业务员、后端安全工程师最终复核均为 `APPROVE`。
- 非阻断测试遗留：后续把 trace、密文、Job 状态和 Shard 状态篡改用例补充到真实 MySQL 冷启动专项；当前已在内存专项覆盖，MySQL 已覆盖 Job HMAC 篡改。

### 尚未开始

- Worker 领取、租约、心跳、运行中状态、重试退避、崩溃恢复和队列消费。
- Provider 搜索执行、外部网络请求和请求事实记录。
- 真实游标、水位线、配额/预算消耗、重试和断点续跑。
- 候选企业生成、清洗、核验、去重和 CRM 转化。
- Search Run Control Plane v1 与 Queue Bridge v1 均没有修改现有自动搜客前端界面。

## 已完成

- 前后端分离工程：
  - `frontend`：Vite + 高保真原型 `index.html` + TypeScript 增强脚本
  - `backend`：Node + Express + TypeScript
- 前端已重新对齐根目录高保真原型：
  - 运行页面直接使用原型视觉、布局、密度和 PPT 级报表模块
  - `frontend/src/prototype-api.ts` 只负责登录、权限、数据刷新和按钮动作
- 登录与 JWT 认证
- 账号角色：
  - 业务员：仅本人数据
  - 主管：本团队全部数据
  - 管理员：全量权限
- 后端数据范围过滤：
  - 客户
  - 待办
  - 账号列表
  - 汇报摘要
- 前端页面：
  - 登录
  - 工作台
  - 待办清单
  - 客户管理
  - 商机管道
  - 跟进提醒
  - 导入导出
  - 经营汇报
  - 企业微信
  - 资料维护
  - 在线考试
  - 小工具 OCR
  - 账号管理
- 原型功能增强：
  - 登录真实调用 `/api/auth/login`
  - 业务员、主管、管理员切换时重新加载对应数据范围
  - 待办清单可完成
  - 工作台待办支持新增、快捷输入、筛选、批量完成、完成反馈
  - 客户管理支持新增客户、点击客户行切换详情、记录跟进动作
  - 商机管道支持点击商机卡片“推进阶段”
  - 跟进提醒支持完成提醒
  - 导入导出支持创建导入任务、提交导出审批任务
  - 资料维护支持上传资料、发布资料、批量发布、类目操作反馈
  - 在线考试支持创建考试、发布考试、进入考试、选择答案、提交判分
  - 小工具 OCR 支持加载名片、重新识别、编辑勾选字段、同步线索
  - 报表模块支持生成可下载经营汇报文本
  - 账号管理支持新增账号弹窗、权限模板、保存设置反馈
  - 客户、商机、提醒、导入导出、企微、资料、考试、账号列表从后端刷新
  - OCR 识别字段可勾选、编辑，并可同步到线索
- OCR 名片同步线索接口和前端按钮状态。
- MySQL 建表脚本：`backend/schema.mysql.sql`
- 真实持久化层：
  - 后端已抽象 `CrmStore`
  - 默认内存模式便于原型开发
  - 设置 `CRM_STORE=mysql` 或 `DATABASE_URL` / `MYSQL_URL` 后切换到 MySQL
  - MySQL 启动时自动建表；仅开发/测试环境的空库会写入脱敏测试种子
  - 生产环境只创建显式配置的初始超级管理员，业务表保持为空
  - 写接口会等待 `persist()` 完成后再返回，避免前端成功但数据库未落盘
- 页面级自动化测试：
  - Playwright 覆盖登录、首页待办、客户新增、资料维护、在线考试、OCR 同步、PPT 级报表导出

## 已验证

- `npm run test --workspace backend`
  - 业务员只能看到本人负责的数据
  - 团队管理员只能看到本团队数据
  - 不同公测团队之间的数据相互不可见
  - OCR 名片可同步为线索
- `npm run test --workspace frontend`
  - 高保真原型关键模块存在
  - 增强脚本接口路径存在
- `npm run build`
  - 后端 TypeScript 编译通过
  - 前端生产构建通过
- `npm run test:e2e`
  - 页面级自动化测试 5 条通过
  - 自动启动后端 `4188` 与前端 `5188`
  - 使用本机 Google Chrome 通道执行，避免依赖 Playwright Chromium 下载缓存
- 浏览器端到端验证：
  - 登录页显示正常
  - 业务员登录：3 个客户 / 3 个待办 / 本人数据范围
  - 主管登录：5 个客户 / 5 个待办 / 团队数据范围
  - 所有主导航页面可打开：工作台、客户、商机、提醒、导入导出、汇报、企微、资料、考试、小工具、账号
  - 商机阶段可修改
  - 跟进提醒可完成
  - 导入导出任务可新建
  - OCR 同步按钮从“同步到线索”变为“已同步”
  - 主管账号管理页显示团队账号
  - 资料维护、在线考试、小工具模块均非空白
  - PPT 级报表模块保留 6 个汇报面板
  - 1280px 桌面视口无横向溢出
  - 控制台无前端错误
- 当前已按界面落地核心交互：
  - 工作台：新增待办、筛选、完成、批量完成
  - 客户管理：新增客户、点击行查看详情、跟进记录反馈
  - 商机管道：推进阶段并刷新管道
  - 跟进提醒：完成提醒
  - 导入导出：创建导入/导出任务
  - 资料维护：上传资料、发布资料、批量发布
  - 在线考试：创建考试、发布考试、答题交卷
  - 小工具 OCR：加载/识别/编辑/同步线索
  - 报表：导出汇报文件
  - 账号管理：新增账号与权限保存反馈

## 本地启动

```bash
cd GoodJob/CRM
npm run dev
```

访问：

- 前端：http://127.0.0.1:5188/
- 后端：http://127.0.0.1:4188/

## MySQL 持久化

默认不设置环境变量时使用内存模式。开发环境启用 MySQL：

```bash
cd GoodJob/CRM
CRM_STORE=mysql DATABASE_URL="mysql://user:password@127.0.0.1:3306/goodjob_crm" npm run dev
```

也可以使用：

```bash
MYSQL_URL="mysql://user:password@127.0.0.1:3306/goodjob_crm" npm run dev
```

生产环境必须显式配置 `DATABASE_URL` 或 `MYSQL_URL`，并配置
`INITIAL_ADMIN_EMAIL`、至少 12 位的 `INITIAL_ADMIN_PASSWORD`。首次启动只创建该超级管理员，
不会导入开发测试客户、线索、商机或其他业务数据。

健康检查：

```bash
curl http://127.0.0.1:4188/api/health
```

返回 `{"ok":true,"store":"mysql"}` 表示当前实际使用 MySQL；返回 `memory` 表示仍在内存模式。

当前 MySQL 持久化为原型阶段的事务级全量替换写入，已保证写接口等待落盘后返回。生产化时建议继续拆成按表、按行的增量写入，并补充审计日志和备份任务。

## 自动化测试

```bash
npm run test
npm run test:e2e
```

页面级测试固定使用：

- 后端：http://127.0.0.1:4188/
- 前端：http://127.0.0.1:5188/

## 下一轮建议

1. 增加真实 OCR 文件上传和图片识别服务。
2. 增加真实 PDF/PPT 导出。
3. 增加导入 Excel 字段映射和错误行修正。
4. 增加 MySQL 备份、恢复、审计日志与迁移脚本。

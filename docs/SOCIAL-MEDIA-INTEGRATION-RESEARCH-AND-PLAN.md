# GoodJob CRM 社媒集成调研与开发方案

版本：1.0  
调研日期：2026-07-21  
范围：TikTok、YouTube、Facebook；兼顾后续 Instagram、LinkedIn 扩展  
状态：产品与技术方案，尚未进入开发

## 1. 执行结论

该能力可落地，但必须区分“开源管理界面”和“平台授权能力”：

1. 开源项目可以提供账号管理、内容日历、定时发布和统一工作台，但不能绕过 TikTok、Google、Meta 的官方应用审核、OAuth、配额和权限政策。
2. TikTok 有官方二维码授权流程，可以实现真正的扫码绑定。
3. Facebook 和 YouTube 的普通 Web 应用应使用官方 OAuth 跳转。可以由 GoodJob 生成一次性二维码，让用户在手机扫码后进入官方 OAuth，但不能把 YouTube 的电视/受限输入设备授权流程冒充网页扫码。
4. 三个平台都不能被描述为“扫码后拥有所有能力”。发布、评论、私信、线索等能力各不相同，且部分权限需要平台审核。
5. 不建议把 Postiz、Mixpost 或 Chatwoot 整套嵌入 GoodJob。建议保留它们作为产品和连接器参考，在现有 Express + MySQL + BullMQ 架构中原生开发“社媒中心”。
6. 第一阶段优先 Facebook Pages 与 Lead Ads，其次 YouTube，最后 TikTok。原因不是技术难度，而是外贸获客闭环价值：Facebook 的公共主页、评论、消息和广告表单最接近可转化线索。

最终建议：采用“GoodJob 原生社媒连接层 + 官方 API + 一次性扫码授权桥 + CRM 线索闭环”，不复制 AGPL 代码，不使用 Cookie、浏览器模拟登录或逆向接口。

## 2. 用户真正需要的产品

本功能不是另一个内容发布器，而是从社媒触达到 CRM 成交的闭环：

```text
绑定企业社媒账号
  -> AI 生成并按平台改写内容
  -> 审批/定时发布
  -> 收集评论、消息、表单线索和互动信号
  -> 去重并创建 CRM 线索
  -> AI 背调、评分、分配业务员
  -> Communication / 邮件持续跟进
  -> 创建商机并记录成交
  -> 按渠道、内容和活动回看收入贡献
  -> 将有效打法沉淀到业务员训练与 Agent 记忆
```

如果只做“发帖”，它是营销工具；完成上述链路后，它才是外贸获客 CRM 的组成部分。

## 3. 开源项目调研

### 3.1 Postiz

- 仓库：https://github.com/gitroomhq/postiz-app
- 文档：https://docs.postiz.com
- 许可证：AGPL-3.0
- 调研时仓库信号：约 33.6k Stars、2,693 commits
- 覆盖：TikTok、YouTube、Facebook、Instagram、LinkedIn、Threads、Pinterest 等
- 授权：官方 OAuth；公开 API 可生成渠道授权地址
- 优点：覆盖平台多、产品完成度高、内容排期与发布能力成熟、Node 生态接近 GoodJob
- 风险：AGPL-3.0 对网络服务和修改版本有源码提供义务；直接复制或深度合并到闭源商用 CRM 会带来明确合规负担
- 结论：适合作为产品、接口和异常处理参考；不复制其代码进入 GoodJob。只有在公司接受 AGPL 合规、单独部署且公开对应源码时，才考虑作为独立服务使用。

### 3.2 Mixpost Lite

- 仓库：https://github.com/inovector/mixpost
- 文档：https://docs.mixpost.app/lite/
- 社媒服务文档：https://docs.mixpost.app/services/
- 许可证：MIT
- 调研时仓库信号：约 3.4k Stars；Lite 最新版本 2.6.0（2026-03-16）
- 覆盖：Facebook/Instagram、TikTok、YouTube、LinkedIn、Pinterest、Threads 等
- 优点：MIT 商用友好；可自托管；官方文档明确包含 TikTok、YouTube、Facebook 的应用配置
- 风险：核心技术栈是 PHP/Laravel + Vue；整套引入会给当前 Node 项目增加 PHP、队列、定时任务和升级链路；Lite 与 Pro/Enterprise 功能边界需要持续核对
- 结论：许可证最适合借鉴；可参考其 MIT 连接器设计并保留版权声明，但不建议把整套 Laravel 系统作为 GoodJob 的第三个业务后端。

### 3.3 Chatwoot

- 仓库：https://github.com/chatwoot/chatwoot
- 许可证：MIT
- 调研时仓库信号：约 34.6k Stars、6,446 commits
- 覆盖：网站聊天、邮件、Facebook、Instagram、WhatsApp、Telegram、LINE、SMS 等统一收件箱
- 优点：统一对话、分配、标签、团队协作与会话审计成熟
- 风险：Ruby on Rails + PostgreSQL + Redis，体量较大；不覆盖 TikTok 与 YouTube 的内容运营闭环；完整嵌入会重复当前 Communication 能力
- 结论：用于参考 Facebook/Instagram 收件箱和客服分配体验，不作为本次底座。

### 3.4 排除项

- n8n：适合自动化编排，但不是社媒运营产品；其 Sustainable Use License 也不等同于 OSI 开源许可证。
- 各类 Cookie/Session 抓取、Playwright/Selenium 自动登录项目：无需平台审核但有账号封禁、验证码、风控、密码泄漏和协议违约风险，禁止进入生产方案。
- 长期未维护的 SocialBoard/Socioboard 类项目：平台 API 变化快，连接器停止维护后不可用，不适合作为 CRM 核心依赖。
- 付费聚合 API：可作为未来快速扩展选项，但不满足“免费、可控、开源优先”的当前目标。

## 4. 官方平台能力与限制

| 平台 | 推荐绑定方式 | 扫码体验 | 可落地能力 | 首期不承诺 | 关键前置条件 | 结论 |
|---|---|---|---|---|---|---|
| TikTok | Login Kit OAuth 2.0 | 官方提供 QR Code Authorization | 获取授权账号基本信息、读取公开视频、上传/发布视频或图片 | 通用私信收件箱、任意账号评论管理、未经审核公开发帖 | TikTok Developer App、Login Kit、Content Posting API、应用审核 | 可集成，扫码体验最好，但审核前发布内容会受限 |
| YouTube | Google Web Server OAuth 2.0 | GoodJob 一次性二维码桥接到官方 OAuth；不使用设备码冒充 Web 授权 | 频道信息、视频上传、视频/播放列表管理、评论读写、部分分析 | 私信、无限搜索、无审核的大规模公开上传 | Google Cloud Project、YouTube Data API、OAuth 验证、配额管理 | 可集成，功能稳定，适合内容和评论获客 |
| Facebook | Facebook Login for Business / Page Access Token | GoodJob 一次性二维码桥接到官方 OAuth | 公共主页发帖/排期、照片/视频、评论互动、Page 消息、Lead Ads Webhook | 个人主页自动发帖、任意冷启动私信、绕过消息窗口规则 | Meta Business App、业务验证、App Review、Page 权限 | 可集成，外贸获客价值最高，建议先做 |

### 4.1 TikTok

官方资料：

- Login Kit Web：https://developers.tiktok.com/doc/login-kit-web/
- QR Code Authorization：https://developers.tiktok.com/doc/login-kit-qr-code-authorization
- Login Kit Overview：https://developers.tiktok.com/doc/login-kit-overview/
- Content Posting API：https://developers.tiktok.com/doc/content-posting-api-get-started
- App Review FAQ：https://developers.tiktok.com/doc/getting-started-faq

关键判断：

- Login Kit 基于 OAuth 2.0，官方有二维码授权流程，因此 TikTok 可以提供原生扫码绑定。
- Content Posting API 支持直接发布或上传草稿，但应用需要审核。
- TikTok 官方 FAQ 明确：未审计客户端发布的内容会被限制为仅自己可见。开发完成不等于能立即公开商用。
- 普通开发者 API 不提供一个可替代 TikTok App 的完整私信工作台，首期不能承诺自动冷私信。
- TikTok Lead Generation 属于营销/广告业务权限，应与普通 Login Kit 分开申请并作为后续阶段。

### 4.2 YouTube

官方资料：

- Web Server OAuth：https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps
- Device OAuth：https://developers.google.com/youtube/v3/guides/auth/devices
- API 配额：https://developers.google.com/youtube/v3/determine_quota_cost
- 配额与合规审核：https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits

关键判断：

- GoodJob 是可保存服务器密钥的 Web 应用，应使用 Web Server OAuth，并在后端安全保存 refresh token。
- Google 的 Device OAuth 明确面向电视、游戏机、打印机等无法访问浏览器或输入受限的设备，不应用于普通 CRM 网页。
- 为满足扫码体验，GoodJob 可生成一个短期、单次使用的授权二维码。手机打开 GoodJob 授权票据后再跳转 Google 官方 OAuth，授权结果回到服务器，桌面端轮询完成绑定。
- 默认配额为每天 10,000 units；当前官方费用表中 `videos.insert` 为 1,600 units，`search.list` 为 100 units，常规 list 多为 1 unit。必须建立配额预算，不能无限轮询或全量搜索。
- 公开应用请求敏感范围时需要 OAuth 验证；令牌、隐私政策、数据删除能力都是上线条件。

### 4.3 Facebook

官方资料：

- Pages API Posts：https://developers.facebook.com/docs/pages-api/posts/
- Permissions Reference：https://developers.facebook.com/docs/permissions/
- Meta Platform Terms：https://developers.facebook.com/terms/dfc_platform_terms/
- Developer Policy：https://developers.facebook.com/devpolicy/

关键判断：

- 官方 Pages API 支持创建、定时、更新、删除公共主页帖子，并支持照片和视频。
- 发帖所需权限包括 `pages_manage_posts`、`pages_read_engagement`，互动还涉及 `pages_manage_engagement`；视频需要 `publish_video`。
- 用户必须对目标 Page 具备相应任务权限。不能把“绑定 Facebook 个人账号”理解为可以向个人主页任意自动发帖。
- Page 消息和 Lead Ads 分属额外产品/权限，需单独审核并遵守消息时限、用户发起会话和广告数据政策。
- 普通网页采用 Facebook Login for Business。GoodJob 可以把自己的单次授权入口编码为二维码，但最终授权页、权限确认和令牌签发必须由 Meta 完成。

## 5. “免费”的准确解释

本方案可不购买第三方聚合 API，但不是零成本：

- 开源代码成本：GoodJob 自研连接层无需购买 SaaS；Mixpost Lite/Chatwoot 为 MIT；Postiz 为 AGPL-3.0。
- 平台调用成本：Meta、TikTok、YouTube 的上述开发者 API 通常不按每次调用收费，但受审核、配额、平台政策和账号资格限制。
- 必然成本：服务器、Redis/队列、视频临时存储、出口流量、日志、监控、备份、域名与隐私政策页面。
- 人力成本：三家开发者应用的材料准备、录屏、审核答复、权限续审和 API 升级维护。
- 失败成本：如果使用非官方 Cookie/浏览器自动化，封号和客户数据泄漏成本远高于 API 成本，因此不纳入方案。

## 6. 产品信息架构

新增一级业务页面“社媒中心”，放在 Communication 相邻位置，不塞入系统设置，也不把三个平台拆成三个菜单。

### 6.1 社媒中心

顶部只保留三个主视图：

1. 工作台
2. 内容日历
3. 互动与线索

账号管理由右上角“连接账号”进入抽屉，不长期占用页面。

### 6.2 工作台

- 已连接账号：平台、账号头像、Page/Channel、负责人、授权状态、最近同步时间
- 今日执行：待审批、待发布、发布中、失败重试
- 当前收获：新增互动、识别线索、已转客户、已建商机、归因金额
- 风险：令牌即将过期、平台审核未完成、配额不足、Webhook 异常
- 最近活动流：发布、评论、线索转化和 Agent 动作，持续追加而非覆盖

### 6.3 内容日历

- 周/月视图与待发布队列
- 一个母稿，多平台版本并列编辑
- AI 按平台重写：TikTok 短文案、YouTube 标题/描述、Facebook 帖子
- 平台预检：尺寸、时长、字符、隐私级别、受众、儿童内容声明
- 审批状态：草稿、待审批、已批准、排队、发布中、成功、部分成功、失败
- 失败目标可单独重试，禁止整批重复发布

### 6.4 互动与线索

- Facebook 评论/Page 消息/Lead Ads，YouTube 评论；TikTok 只展示官方 API 实际允许的数据
- AI 识别采购意向、国家、公司、产品、数量、时间窗口和情绪
- 一键创建线索；按邮箱、电话、社媒账号、公司域名做去重
- 建立社媒身份与 CRM 联系人的关联，不把平台昵称直接当成客户
- 转换后进入现有 AI 背调、线索分配、开发信、Communication 和商机流程
- 每条线索保留来源平台、账号、内容、互动和 UTM，支持成交归因

### 6.5 系统设置（仅管理员可见）

- 平台应用配置：Client ID、Client Secret、回调地址、审核状态
- 已批准权限与功能开关
- 媒体保留：立即删除或保留 N 天
- 团队账号共享策略、审批策略、发布限额
- Webhook 状态、配额和数据删除任务

业务员不能看到 Client Secret、refresh token 或系统级开发者应用配置。

## 7. 账号绑定设计

### 7.1 统一流程

1. 用户点击“连接账号”。
2. 选择 TikTok、YouTube 或 Facebook。
3. 后端创建 2 分钟有效、单次使用的授权事务，绑定当前用户、团队、平台、state、PKCE 和随机 nonce。
4. 前端同时显示“手机扫码”和“当前浏览器继续”。
5. TikTok 使用官方 QR Authorization；YouTube/Facebook 的二维码包含 GoodJob 单次授权 URL，随后跳转官方 OAuth。
6. 平台回调后，后端先将连接置为 `pending_confirmation`。
7. 桌面显示授权账号头像、名称和具体 Page/Channel，由原用户点击“确认绑定”。
8. 确认后加密保存 token；二维码、授权码和临时事务立即失效。

### 7.2 安全要求

- OAuth state、PKCE、nonce 缺一不可
- 二维码不包含 access token、refresh token、Client Secret 或 CRM JWT
- 票据只能使用一次，默认 120 秒失效
- 扫码者完成授权后，桌面端必须再次确认账号身份，防止换码绑定
- refresh token 使用独立主密钥进行信封加密；数据库只存密文与 key version
- 日志只保存 token 指纹和末四位，不记录明文
- 解绑时同时撤销平台 token、停止任务、清理 Webhook 订阅并记录审计

## 8. 权限和账号归属

连接分两种，不混用：

- 个人连接：仅绑定者可见和使用，管理员只能看到健康状态，不能读取 token。
- 团队资产：Facebook Page、YouTube Channel、企业 TikTok 等公司资产；绑定者提交后由管理员确认共享范围，授权给指定成员或角色。

角色规则：

- 管理员：配置平台应用、审批团队资产、设置发布限额和媒体保留策略
- 经理：审批团队内容、查看团队归因、分配社媒线索
- 业务员：使用授权渠道、处理分配给自己的互动与线索；不可进入系统设置
- AI Agent：不能读取平台密钥、OAuth 事务和 token；只能调用经过策略层允许的业务动作

## 9. 技术架构

不新增 PHP/Ruby 运行时，直接复用现有能力：

- Express：OAuth、业务 API、Webhook
- MySQL：连接、内容、互动、线索关联、审计
- BullMQ：定时发布、token 刷新、Webhook 消费、同步和重试
- 现有二维码库：YouTube/Facebook 一次性授权桥
- 现有密钥体系：新增独立 `SOCIAL_CREDENTIAL_KEY`，不得复用 JWT 或 WhatsApp 密钥
- 现有 Agent 审批和幂等机制：外部发布、评论回复和线索写入
- 现有媒体保留策略：上传成功后立即删除或保留 N 天

### 9.1 模块边界

```text
frontend/social-hub
  -> backend/social-api
      -> social-oauth-service
      -> social-provider-contract
          -> facebook-provider
          -> youtube-provider
          -> tiktok-provider
      -> social-publication-service
      -> social-engagement-service
      -> social-lead-conversion-service
      -> social-webhook-consumer
      -> social-audit-service
```

每个平台实现统一能力契约：

```text
authorize / refresh / revoke
listChannels
validateContent
publish / getPublishStatus / deletePost
syncEngagements / reply (仅平台允许时)
normalizeWebhook
getQuotaHealth
```

不支持的能力必须返回明确的 `capability_not_supported`，不能静默伪造成功。

## 10. 数据模型

建议新增以下表：

- `social_platform_apps`：平台开发者应用、环境、审核状态、加密密钥引用
- `social_oauth_transactions`：单次授权票据、state、PKCE、过期时间、状态
- `social_connections`：团队、所有者、平台用户、token 密文、scope、过期时间、健康状态
- `social_channels`：Page/Channel/TikTok Account 与连接的关系、共享范围
- `social_drafts`：母稿、目标、审批状态、作者
- `social_publications`：一次发布任务、计划时间、幂等键、总体状态
- `social_publication_targets`：每个平台目标、平台载荷、远端 ID、失败码、重试次数
- `social_media_assets`：文件哈希、MIME、大小、存储位置、删除时间
- `social_engagements`：评论、消息、表单线索、去重键、原始引用
- `social_identity_links`：平台身份与 lead/contact/customer 的可信关联
- `social_attributions`：活动、内容、互动、线索、商机和成交关系
- `social_webhook_events`：签名验证、事件 ID、幂等状态、处理结果
- `social_audit_logs`：授权、发布、回复、解绑、Agent 动作和审批快照

所有业务表必须带 `team_id`；个人连接额外带 `owner_user_id`，并复用现有团队隔离测试模式。

## 11. API 草案

### 11.1 管理员配置

```text
GET    /api/social/admin/platform-apps
PUT    /api/social/admin/platform-apps/:platform
POST   /api/social/admin/platform-apps/:platform/test
GET    /api/social/admin/platform-apps/:platform/review-readiness
```

### 11.2 账号绑定

```text
POST   /api/social/oauth/:platform/transactions
GET    /api/social/oauth/transactions/:id
GET    /api/social/oauth/:platform/callback
POST   /api/social/oauth/transactions/:id/confirm
POST   /api/social/oauth/transactions/:id/cancel
GET    /api/social/connections
POST   /api/social/connections/:id/refresh
DELETE /api/social/connections/:id
```

### 11.3 内容与发布

```text
POST   /api/social/drafts
PATCH  /api/social/drafts/:id
POST   /api/social/drafts/:id/ai-rewrite
POST   /api/social/drafts/:id/validate
POST   /api/social/drafts/:id/submit
POST   /api/social/drafts/:id/approve
POST   /api/social/publications
GET    /api/social/publications/:id
POST   /api/social/publications/:id/cancel
POST   /api/social/publication-targets/:id/retry
```

### 11.4 互动、线索与 Webhook

```text
GET    /api/social/engagements
POST   /api/social/engagements/:id/reply
POST   /api/social/engagements/:id/convert-to-lead
POST   /api/social/engagements/:id/link-contact
POST   /api/social/webhooks/facebook
POST   /api/social/webhooks/tiktok
POST   /api/social/webhooks/google
GET    /api/social/attribution
```

Webhook 路由不接受 CRM Session，必须验证平台签名；OAuth、Webhook、密钥管理接口不向 AI Agent 开放。

## 12. AI Agent 接入

Agent 可用工具：

- 查看已授权渠道和能力，不读取 token
- 根据产品、市场和客户画像生成母稿
- 为各平台生成差异化版本并执行发布前校验
- 创建草稿、提交审批、查询发布状态
- 对互动做意向分类、公司识别、去重和线索建议
- 在有明确审批的情况下回复评论或执行已批准的发布计划
- 将线索交给现有背调、分配、开发信和客户维护任务

Agent 禁止：

- 创建或修改平台 Client Secret
- 发起或确认 OAuth 绑定
- 读取 access/refresh token
- 绕过平台审核、风控或配额
- 未经审批进行外部发布、批量回复或广告操作
- 调用 Webhook 接收接口

审批必须保存不可变快照：平台、账号、文本、媒体哈希、可见性、计划时间和目标受众。审批后任何字段变化都必须重新审批。

## 13. 多轮产品审核

### 第一轮：高级外贸业务员审核

质疑：只做发帖对获客价值有限，业务员最终需要可跟进的人和明确的采购信号。

调整：

- 将“互动与线索”提升为一级主视图，不放在分析报表深处
- Facebook Lead Ads、Page 消息和评论优先于纯内容数据
- YouTube 评论进入意向识别；TikTok 不支持的私信能力不做虚假入口
- 所有社媒线索必须能进入背调、分配、跟进、商机和成交归因

审核结果：有条件通过。闭环指标必须是有效线索和商机，不是发帖数量。

### 第二轮：高级产品经理审核

质疑：三个平台能力差异很大，强行做完全统一的页面会让用户误以为每个平台都支持同样功能。

调整：

- 统一任务模型，不统一不存在的平台能力
- 编辑器采用母稿 + 平台版本；每个目标显示真实能力和预检结果
- 账号连接、内容、互动三个主流程保持清晰，不堆砌小标签
- 不把应用密钥配置暴露给业务员
- MVP 按 Facebook -> YouTube -> TikTok 逐个平台交付，避免三线同时半成品

审核结果：通过。界面必须以任务和结果组织，不以 API 名称组织。

### 第三轮：架构与安全审核

质疑：扫码、refresh token、Webhook 和自动发布均属于高风险外部能力；复制 AGPL 代码会给商用带来额外义务。

调整：

- 原生实现 provider contract，不复制 Postiz AGPL 代码
- TikTok 使用官方 QR；Facebook/YouTube 使用 GoodJob 单次授权桥 + 官方 OAuth
- token 独立加密、最小 scope、密钥轮换、Webhook 签名、幂等和审计全部列为上线门槛
- 外部发布与回复接入现有 Agent 审批和不可变快照
- 明确禁止 Cookie、密码托管和浏览器模拟登录

审核结果：通过。未完成安全验收的平台只能处于测试模式。

### 第四轮：商业化与运营审核

质疑：功能开发完成后仍可能卡在 Meta/TikTok/Google 审核，不能把审核时间当作代码工期。

调整：

- Phase 0 先启动三家开发者应用、隐私政策、服务条款和删除回调准备
- 每个平台使用 feature flag；审核通过一个开放一个
- 未审核 TikTok 仅允许测试账号和私密内容
- 建立 API 版本、配额、token 过期和 Webhook 健康看板
- 商业宣传中只描述已审核、已验收的能力

审核结果：通过。平台审核是独立发布门禁，不与开发完成混为一谈。

## 14. 开发阶段

### Phase 0：平台申请与合规材料（与开发并行）

- 创建 Meta Business App、TikTok Developer App、Google Cloud Project
- 准备隐私政策、服务条款、数据删除页面和演示账号
- 固定正式回调域名与 HTTPS
- 形成权限申请矩阵、审核录屏脚本和测试账号

完成标准：三家平台都能在开发/测试账号范围完成 OAuth。

### Phase 1：社媒连接底座

- 数据表、provider contract、密钥加密、token 生命周期
- 账号连接抽屉、一次性二维码事务、授权确认
- 管理员平台配置和权限隔离
- Webhook 骨架、审计、幂等、失败码规范

完成标准：Mock Provider 和三个平台沙箱授权测试通过；跨团队无法看到连接。

### Phase 2：Facebook 获客闭环

- Page 选择、帖子/图片/视频、定时发布
- 评论同步与回复、Page 消息能力按审核权限开放
- Lead Ads Webhook -> 线索去重 -> 分配 -> 背调
- UTM 与内容/活动归因

完成标准：从 Facebook 表单或评论创建线索并最终关联商机；重复 Webhook 不重复建线索。

### Phase 3：YouTube 内容与评论

- OAuth、频道识别、配额预算
- 可续传视频上传、缩略图、播放列表、发布状态
- 评论同步、回复与意向识别
- 上传媒体按立即删除/N 天策略清理

完成标准：断点续传可恢复；重复请求不重复上传；配额不足时提前阻断并给出恢复时间。

### Phase 4：TikTok 扫码与发布

- 官方 QR Authorization
- Display API 账号/视频信息
- Content Posting API 上传、直接发布、状态轮询
- 审核前测试模式和私密可见性强提示

完成标准：二维码过期/重复扫码/换码攻击被阻断；审核状态与发布可见性一致。

### Phase 5：统一日历、AI 与归因

- 母稿、多平台版本、平台预检、审批和局部重试
- Agent 内容生成、互动分类、线索建议和发布任务
- 渠道、内容、活动、线索、商机、成交归因
- 业务员训练数据回流：哪些内容和回复带来有效线索/成交

完成标准：从 Agent 创建草稿到人工审批、发布、互动、线索和商机形成完整审计链。

## 15. 测试计划

### 单元与契约测试

- 每个平台 provider contract 的成功、限流、token 失效、权限不足、配额不足和结构变化
- 内容约束、媒体校验、平台载荷和错误归一化
- OAuth state/PKCE/nonce、二维码过期、单次使用和桌面确认
- Webhook 签名、重放、乱序和幂等

### 权限与安全测试

- 40 个团队账号跨团队隔离
- 业务员不能访问平台应用设置和密钥
- 管理员不能查看个人连接 token
- Agent 不能访问 OAuth、token、Webhook 和管理员接口
- 日志、错误、导出和前端状态中不存在明文 token

### 业务测试

- 母稿在三个平台生成不同版本
- 部分平台失败时只重试失败目标
- 评论/表单线索去重后正确分配
- 线索转客户、商机、成交后的来源归因完整
- 解绑后排期停止且 token 撤销

### E2E 与视觉测试

- 13、16、24、27 英寸常见 PC 视口
- 连接账号、扫码等待、授权成功、授权失败、过期、重连
- 日历密度、长标题、长账号名、多账号和空状态
- 流式活动不断向下追加，不覆盖现有记录
- 无卡片套卡片、无大量小标签、无界面说明性文字

## 16. 上线门禁

任一平台只有同时满足以下条件才能正式开放：

1. 官方应用/权限审核通过
2. 正式域名 HTTPS、回调 URL、隐私政策和数据删除流程可用
3. token 加密、轮换、撤销和日志脱敏测试通过
4. Webhook 签名与重放测试通过
5. 发布幂等、部分失败和人工审批测试通过
6. 配额/限流监控与熔断可用
7. 平台能力矩阵和 UI 实际行为一致
8. 数据保留策略和删除任务验收通过
9. Agent 无法绕过审批或访问密钥
10. 生产沙箱小范围试用一周无重复发布、串号或越权

## 17. 粗略排期与投入

以 1 名后端、1 名前端、1 名测试/产品兼职配合估算：

- Phase 0：平台审核准备 3-5 人日，平台审核等待时间另计
- Phase 1：6-9 人日
- Phase 2：8-12 人日
- Phase 3：7-10 人日
- Phase 4：8-12 人日
- Phase 5：8-12 人日
- 安全、E2E、部署与灰度：6-9 人日

总开发量约 43-64 人日。平台审核可能并行，但不能承诺固定完成日期。建议先交付 Facebook 闭环，再按平台逐步开放。

## 18. 最终决策

批准进入开发的方案：

- 产品名称：社媒中心
- 技术路线：GoodJob 原生 provider contract + 官方 OAuth/API
- 扫码：TikTok 官方 QR；Facebook/YouTube 使用 GoodJob 单次二维码桥接官方 OAuth
- 开源策略：参考 Postiz、Mixpost、Chatwoot；不复制 AGPL 代码；MIT 代码如有实际复用必须保留许可证和版权声明
- 首发顺序：Facebook -> YouTube -> TikTok
- 核心指标：有效线索、线索转客户、商机和成交归因；发帖数量只作为过程指标
- 禁止路线：Cookie 抓取、浏览器模拟登录、账号密码托管、未审核公开自动发布

在正式开发前，只需由产品负责人确认一个业务选择：Facebook 首期是否同时申请 Page Messaging 与 Lead Ads。它不影响连接底座开发，但会影响 Phase 2 的审核材料与验收范围。


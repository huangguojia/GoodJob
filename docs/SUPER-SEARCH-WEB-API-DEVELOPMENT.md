# 超级搜索实时网页与地图企业搜索开发方案

版本：v1.0  
状态：审核通过，进入开发  
边界：只调用搜索服务与 Google Places 官方 API，不抓取搜索结果页、Google Maps 页面或结果网页正文。

## 1. 产品目标

在超级搜索配置区增加“实时网页搜索”“地图企业搜索”和“AI 深度发现”三个独立可选项。关闭时沿用现有企业库和采购 API；开启后，对应 Provider 参加每一轮查询矩阵。

实时网页搜索不等同于 AI 生成候选。候选必须来自搜索 API 返回的结构化标题、URL 和摘要，并保留搜索时间、Provider、查询单元和来源链接。

地图企业搜索使用 Google Places API (New) Text Search，返回企业地点名称、地址、官网、电话、营业状态、Place ID 和 Google Maps 链接。地图结果属于发现证据，不直接视为工商主体核验结果。

AI 深度发现使用当前账号已启用且勾选自动获客的模型，按严格结构化契约生成候选企业。AI 候选必须标记为辅助发现，不能伪装成实时网页或工商核验结果，并与其它来源统一去重。

## 2. 非爬虫边界

- 允许：Serper、Brave Search、SerpAPI 等官方搜索 API。
- 允许：Google Places API (New) 官方 Text Search。
- 允许：消费 API 返回的标题、链接、摘要、排名和额度信息。
- 禁止：抓取 Google、Bing、Brave 等搜索结果网页。
- 禁止：自动访问搜索结果中的企业网站。
- 禁止：抓取 Google Maps 页面，或接入依靠地图页面抓取的第三方服务。
- 禁止：绕过登录、验证码、付费墙、robots 或访问频率限制。
- 禁止：将没有来源 URL 的 AI 推测标记为实时网页结果。

## 3. 用户流程

1. 用户切换到超级搜索。
2. 用户开启“实时网页搜索”。
3. 系统刷新当前账号的数据源状态。
4. 系统优先选择已启用且可执行的 Serper、Brave Search 或 SerpAPI。
5. 没有可用 Provider 时不创建任务，直接打开数据源配置。
6. 计划预览显示实时 Web Provider 数量与最大执行单元。
7. 创建任务时后端再次校验策略包含可执行 Web Provider。
8. Worker 按每轮查询主题调用搜索 API，结果进入现有清洗与身份归一管线。

关闭开关时，超级搜索请求不得携带 Web Provider。用户在来源区域手动选择或取消 Web Provider 时，开关状态同步更新。

地图企业搜索默认关闭。开启时必须存在当前账号个人配置且已启用的 `google_places`；未配置时直接定位到 Google Places 配置卡，不创建任务。

AI 深度发现默认关闭。开启时必须存在当前账号可执行的 `ai_search`；没有模型、模型未启用或未授权自动获客时，直接进入 AI 模型配置，不创建任务。AI 查询规划与 AI 候选发现相互独立：前者扩展查询表达，后者实际产出候选。

## 4. Provider 路由

初始优先级：Serper、Brave Search、SerpAPI。启用开关时默认只自动加入一个可用 Provider，避免无意重复计费；用户仍可在来源区域主动选择多个已配置 Web Provider。

Web Provider 必须满足：

- 目录状态为 active；
- 接入方式为 api；
- 当前账号拥有个人连接；
- 连接已启用；
- API Key 可读取；
- Provider 支持 web 能力。

地图 Provider 必须满足：

- Provider 为 `google_places`；
- 目录状态为 active，接入方式为 api；
- 当前账号拥有已启用、可读取的个人 API Key；
- Google Cloud 已启用 Places API (New) 并绑定结算账号；
- Provider 支持 maps 能力。

## 5. 执行链

查询规划器生成市场、语言、买家角色和本轮主题。Web Provider 把结构化条件组合成查询字符串，调用搜索 API，最多读取当前 Provider 允许的结果数量。

每条记录保存：公司候选名、可能的官网、国家、业务摘要、来源 URL、证据摘要、Provider 记录指纹和抓取时间。记录类型固定为 `discovery_page`，不能直接成为已核验企业。

随后复用现有流程：来源解析、字段校验、企业身份归一、来源内去重、跨来源合并、历史覆盖抑制、候选池和待人工处理。

地图查询按每轮选定市场、当地渠道词、买家角色、行业和产品组合生成。一个地图结果最多保留结构化必要字段，不保存 Google 页面 HTML；Place ID 作为 Provider 记录指纹，官网域名继续参与跨来源合并。

## 6. API 契约

超级搜索预览与创建请求新增：

```json
{
  "webSearchMode": "off | api",
  "mapSearchMode": "off | google_places",
  "aiDiscoveryMode": "off | model"
}
```

`api` 模式要求审批策略至少包含一个目录类别为 web、能力包含 web、接入方式为 api 的 Provider。否则返回 `SUPER_SEARCH_WEB_PROVIDER_REQUIRED`。

`off` 模式不得携带 Web Provider，否则返回 `SUPER_SEARCH_WEB_PROVIDER_NOT_ALLOWED`，避免界面开关与实际执行不一致。

`google_places` 模式要求审批策略包含 `google_places`，否则返回 `SUPER_SEARCH_MAP_PROVIDER_REQUIRED`；`off` 模式不得携带 maps Provider，否则返回 `SUPER_SEARCH_MAP_PROVIDER_NOT_ALLOWED`。

`model` 模式要求审批策略包含 `ai_search`，否则返回 `SUPER_SEARCH_AI_DISCOVERY_PROVIDER_REQUIRED`；`off` 模式不得携带 AI 搜索来源，否则返回 `SUPER_SEARCH_AI_DISCOVERY_PROVIDER_NOT_ALLOWED`。

任务读取结果增加派生字段：`webSearchMode`、`webProviderIds`、`mapSearchMode`、`mapProviderIds`、`aiDiscoveryMode` 和 `aiDiscoveryProviderIds`。该状态由审批策略派生，不新增数据库列，策略快照仍是执行事实来源。

## 7. 失败与降级

- 未配置：创建前阻止并引导配置。
- 认证失败：来源失败，不重试，不阻断其它来源。
- 限流：按 Retry-After 退避。
- 网络或 5xx：按任务最大次数重试。
- 搜索成功但无返回：记为成功无结果。
- 单个 Web Provider 失败：其它企业库、采购 API 和 AI 来源继续运行，任务可部分成功。
- Google Places 未启用计费、Key 受限错误或额度不足：保留官方错误码与错误正文，其它来源继续执行。

不把失败伪装成成功，也不生成没有 URL 的替代企业。

## 8. Google Places 合规与费用

- 使用用户自己的 Google Cloud API Key，不提供平台共享 Key。
- API Key 应限制到 Places API (New) 和生产服务器出口 IP。
- 只请求当前界面和清洗所需字段；字段掩码会影响 Google 计费 SKU。
- 界面与导出需保留 Google Maps 来源链接，不得暗示结果是工商认证。
- 上线商用前由管理员复核当期 Google Maps Platform 条款、署名和数据保留要求。
- 不接入 SerpAPI Google Maps、Outscraper 等可能依赖页面抓取的地图来源。

## 9. 审核结论

高级外贸业务员：网页索引用于发现官网与行业目录，Google Places 补充当地经销商、门店、维修商和服务商，企业库与采购来源负责核验和意向信号，形成互补覆盖，通过。

高级产品经理：两个开关只在超级搜索出现并默认关闭；未配置时直接进入对应数据源配置，不增加大量小标签，通过。

高级程序员：复用现有 Provider、个人凭据隔离、请求账本、Worker 和清洗管线；后端校验不依赖前端，Google 请求受域名、路径和方法白名单约束，且不新增网页访问能力，通过。

## 10. 验收标准

- 开关关闭时原超级搜索行为不变。
- 开关开启且有可用 Web Provider 时，预览和任务均包含该 Provider。
- 开关开启但无可用 Provider 时，前端阻止创建，后端也拒绝绕过请求。
- Web 结果全部带来源 URL，任务详情显示来源返回数量与失败报文。
- Google Places 结果带 Place ID、Google Maps 来源链接，并按发现证据进入清洗流程。
- Google Places 未配置时开关自动复位并定位配置卡，不能创建空地图任务。
- AI 模型可用时 AI 搜索候选进入同一清洗池；未配置时开关自动复位并进入模型配置。
- AI 候选在任务详情和来源报告中明确标记，不冒充 Web 或地图结果。
- 配置、任务、请求账本和候选结果保持账号与团队隔离。
- 后端测试、前端自测和生产构建全部通过。

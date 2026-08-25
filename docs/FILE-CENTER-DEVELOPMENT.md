# GoodJob CRM 文件中心开发说明

## 1. 目标

将原有仅保存标题、类目和版本的“资料维护”，改为可实际使用的团队文件中心。文件本体可以保存在百度网盘或其他 HTTPS 文件服务，CRM 保存受权限控制的文件元数据和访问入口。

## 2. 当前支持

- 百度网盘分享 URL 与提取码。
- 其他 HTTPS 文件或网页 URL。
- 标题、类目、版本、格式、说明和标签。
- 草稿、待审核、已发布状态。
- 搜索、类目、来源、状态和格式筛选。
- 资料编辑、发布、删除和访问次数统计。
- 点击打开时记录访问时间和次数。
- 登录鉴权、团队隔离和对象级编辑权限。

## 3. 百度网盘边界

当前采用“分享链接模式”，无需百度 App Key 即可使用：文件由维护人在百度网盘创建分享链接，CRM 保存链接和提取码，已授权团队成员点击后跳转百度网盘。

CRM 不解析分享页、不绕过提取码、不代替百度下载文件，也不把临时下载地址当作永久 URL。这可以避免不稳定的非官方接口和账号风控问题。

若后续需要在 CRM 内浏览个人网盘目录、选择文件和生成临时下载地址，应新增“百度网盘官方连接器”：

1. 在百度网盘开放平台申请应用，配置生产回调域名。
2. 使用 OAuth 让每个管理员授权自己的百度账号。
3. 服务端加密保存 refresh token，短期 access token 不返回前端。
4. 通过官方文件列表和下载接口生成临时地址。
5. 所有授权、选文件、下载和撤销动作写入审计日志。

## 4. 数据模型

`knowledge_assets` 增加：

- `source_type`: `baidu_share`、`external_url`、`legacy`
- `source_url`, `share_code`, `file_type`
- `description`, `tags_json`
- `access_count`, `last_accessed_at`
- `created_at`, `updated_at`

旧记录自动按 `legacy` 读取，并在界面显示“待补链接”。

## 5. 接口

- `GET /api/knowledge/assets`: 当前账号可见资料。
- `POST /api/knowledge/assets`: 添加 URL 资料。
- `PATCH /api/knowledge/assets/:id`: 编辑本人或管理范围内资料。
- `PATCH /api/knowledge/assets/:id/publish`: 管理权限发布资料。
- `POST /api/knowledge/assets/:id/access`: 获取外部 URL 并记录访问。
- `DELETE /api/knowledge/assets/:id`: 删除 CRM 资料记录，不删除外部原文件。

## 6. 安全规则

- URL 必须为 HTTPS。
- 拒绝包含账号密码的 URL。
- 拒绝 localhost、环回、链路本地和常见私网地址。
- 服务端不主动抓取 URL，因此不存在服务端 SSRF 下载链路。
- 提取码只对已登录且有资料可见权限的成员返回。
- 普通成员可提交和维护本人资料；团队发布必须具有 `training.manage`。
- 所有资料读取同时校验当前团队，平台运维身份不能读取租户文件。

## 7. 验收结果

- 后端 TypeScript 构建通过。
- 前端生产构建通过。
- 文件中心专项测试通过。
- 考试系统专项回归通过。
- Agent API 契约和安全回归通过后方可同步个人版。

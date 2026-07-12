# WhatsApp 双模式绑定使用指南

> **实现完成时间：2026-07-12**
> 
> 本文档介绍 GoodJob CRM 中新增的 WhatsApp 双模式绑定功能。

---

## 功能概述

系统现在支持 **三种** WhatsApp 绑定模式，用户可以根据自己的需求和风险承受能力选择：

| 绑定模式 | 说明 | 封号风险 | 成本 | 适用场景 |
|---------|------|---------|------|---------|
| **手动录入** | 手动输入 WhatsApp 号码和消息 | ✅ **零风险** | 免费 | 保守型用户，重视账号安全 |
| **扫码登录** | 通过 WhatsApp Web 协议扫码绑定 | 🔴 **有风险** | 免费 | 测试环境，个人账号 |
| **官方 API** | 通过 Twilio WhatsApp Business API | ✅ **零风险** | ~$120/月起 | 企业级应用，正式环境 |

---

## 一、手动录入模式（默认）

### 特点
- ✅ **零封号风险**：不接入任何第三方接口
- ✅ 完全合规，适合所有用户
- ❌ 需要手动复制粘贴消息

### 使用步骤
1. 进入 **WhatsApp · 聊天** 页面
2. 选择一个客户
3. 在右侧信息栏，绑定模式选择 **"手动录入"**
4. 输入客户的 WhatsApp 号码（例如：+8613800138000）
5. 点击 **"绑定号码"**
6. 在聊天框中手动录入对话内容

### 工作流程
1. 在 WhatsApp 中与客户对话
2. 复制消息内容
3. 在 CRM 中手动录入
4. 系统自动翻译非中文消息

---

## 二、扫码登录模式（Web Scan）

### ⚠️ 重要警告

**此模式使用非官方协议（whatsapp-web.js），可能导致 WhatsApp 账号被封禁！**

- 🔴 **封号风险：高**
- 🔴 **仅建议用于测试环境**
- 🔴 **不要用于重要的商业账号**

### 特点
- ✅ 免费
- ✅ 可以自动接收和发送消息
- ✅ 类似 WhatsApp Web 体验
- ❌ **有封号风险**
- ❌ 需要手机保持在线

### 使用步骤

#### 1. 启动扫码绑定
1. 进入 **WhatsApp · 聊天** 页面
2. 选择一个客户
3. 在右侧信息栏，绑定模式选择 **"扫码登录 (WhatsApp Web)"**
4. 点击 **"开始扫码绑定"** 按钮

#### 2. 扫描二维码
1. 系统会生成一个二维码
2. 打开手机上的 WhatsApp
3. 进入 **设置 → 已连接的设备 → 关联设备**
4. 扫描 CRM 中显示的二维码
5. 等待连接成功

#### 3. 使用功能
- **自动接收消息**：客户发送的消息会自动同步到 CRM
- **发送消息**：在 CRM 中直接发送消息给客户
- **连接状态**：界面会显示连接状态（已连接/未连接）

#### 4. 断开连接
- 点击 **"断开连接"** 按钮
- 或在手机 WhatsApp 中移除设备

### 技术说明
- 使用 `whatsapp-web.js` 库
- 会话数据存储在服务器的 `.wwebjs_auth/` 目录
- 断开连接后会话数据会被清除

---

## 三、官方 API 模式（Twilio）

### 特点
- ✅ **零封号风险**：官方合规方案
- ✅ 企业级稳定性
- ✅ 支持多人协作
- ✅ 支持 Webhook 实时接收消息
- ❌ 需要付费（约 $120/月起）
- ❌ 需要申请 WhatsApp Business API

### 前置条件

#### 1. 申请 Twilio 账号
- 访问 [https://www.twilio.com](https://www.twilio.com)
- 注册并完成账号认证

#### 2. 申请 WhatsApp Business API
- 在 Twilio 控制台申请 WhatsApp 发信号
- 准备材料：
  - 营业执照
  - 公司域名
  - 隐私政策页面
- 等待 Meta 审核（通常 1-3 天）

#### 3. 配置环境变量
在服务器上设置以下环境变量：

```bash
export TWILIO_ACCOUNT_SID="AC..."
export TWILIO_AUTH_TOKEN="..."
export TWILIO_WEBHOOK_URL="https://your-domain.com/api/whatsapp/webhook/twilio"
```

或在 `.env` 文件中：

```env
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_WEBHOOK_URL=https://your-domain.com/api/whatsapp/webhook/twilio
```

#### 4. 配置 Webhook
在 Twilio 控制台配置 Webhook URL：
```
https://your-domain.com/api/whatsapp/webhook/twilio
```

### 使用步骤

#### 1. 绑定 Twilio 号码
1. 进入 **WhatsApp · 聊天** 页面
2. 选择一个客户
3. 在右侧信息栏，绑定模式选择 **"官方API (Twilio)"**
4. 输入 Twilio 分配的 WhatsApp 号码（例如：+14155238886）
5. 点击 **"配置 Twilio"**

#### 2. 发送消息
- **首次联系**：必须使用预审批的模板消息
- **后续对话**：可以自由发送文本消息

#### 3. 接收消息
- 客户发送的消息会通过 Webhook 自动同步到 CRM
- 系统会自动更新未读数和最近消息时间

### 成本估算
- **基础费用**：~$10-20/月（Twilio 账号维护）
- **消息费用**：
  - 发送：$0.005-0.01/条
  - 接收：$0.005/条
- **模板消息**：$0.008/条

**示例**：10 个销售，每人每天 20 条对话
- 月消息数：10 × 20 × 30 = 6000 条
- 月成本：$10 + 6000 × $0.01 = ~$70

### 限制说明
1. **首次联系限制**：首次联系客户必须使用预审批的模板消息
2. **24 小时窗口**：客户回复后，24 小时内可以自由发送消息
3. **禁止群发营销**：不能发送未经同意的营销信息
4. **频率限制**：有发送速率限制（通常足够使用）

---

## 四、如何选择绑定模式？

### 决策树

```
开始
  │
  ├─ 预算充足，重视合规？
  │   └─ 是 → 选择 **官方 API (Twilio)**
  │
  ├─ 只是测试，可以接受封号风险？
  │   └─ 是 → 选择 **扫码登录**
  │
  └─ 重视账号安全，预算有限？
      └─ 是 → 选择 **手动录入**
```

### 推荐场景

| 场景 | 推荐模式 | 原因 |
|-----|---------|-----|
| 个人 SOHO | 手动录入 | 安全、免费 |
| 小团队测试 | 扫码登录 | 快速验证需求 |
| 创业公司 | 手动录入 → 官方 API | 先验证需求，再投入成本 |
| 中大型企业 | 官方 API | 合规、稳定、可扩展 |
| 外贸 B2B | 官方 API | 客户质量高，值得投入 |

---

## 五、常见问题 FAQ

### Q1: 扫码登录后，多久会被封号？
**A:** 这取决于使用频率和行为模式。一些用户使用几个月都没问题，但也有用户几天就被封。**我们强烈建议不要在重要账号上使用此功能。**

### Q2: 可以同时使用多种绑定模式吗？
**A:** 每个客户只能使用一种绑定模式。但不同客户可以使用不同的模式。

### Q3: 如何从扫码模式切换到官方 API？
**A:** 
1. 先断开扫码连接
2. 在绑定模式下拉框选择 "官方API (Twilio)"
3. 配置 Twilio 号码即可

### Q4: Twilio 模式是否支持发送图片、文件？
**A:** 当前版本仅支持文本消息。媒体消息支持将在后续版本中添加。

### Q5: 手动录入模式可以自动翻译吗？
**A:** 可以！非中文消息会自动调用 AI 模型翻译成中文。需要先配置 AI 模型。

### Q6: 扫码登录的会话数据存储在哪里？
**A:** 存储在服务器的 `.wwebjs_auth/` 目录中。断开连接后会自动清理。

### Q7: 为什么我看不到 "官方API (Twilio)" 选项？
**A:** 需要管理员先配置 Twilio 环境变量。请联系系统管理员。

---

## 六、技术架构

### 后端 API 端点

| 端点 | 方法 | 说明 |
|-----|------|-----|
| `/api/whatsapp/binding-modes` | GET | 获取可用的绑定模式 |
| `/api/whatsapp/binding/web-scan/start` | POST | 开始扫码绑定 |
| `/api/whatsapp/binding/web-scan/qr/:clientId` | GET | 获取二维码（SSE） |
| `/api/whatsapp/binding/web-scan/status/:clientId` | GET | 检查连接状态 |
| `/api/whatsapp/binding/web-scan/disconnect` | POST | 断开扫码连接 |
| `/api/whatsapp/binding/twilio/start` | POST | 配置 Twilio |
| `/api/whatsapp/webhook/twilio` | POST | Twilio Webhook |

### 数据库扩展

`whatsapp_bindings` 表新增字段：

```sql
binding_mode VARCHAR(20) DEFAULT 'manual'
user_id VARCHAR(64) DEFAULT ''
session_data TEXT
twilio_phone_number VARCHAR(20) DEFAULT ''
connection_status VARCHAR(20) DEFAULT 'disconnected'
last_connected_at DATETIME NULL
```

### 依赖包
- `whatsapp-web.js`: WhatsApp Web 协议实现
- `qrcode-terminal`: 终端二维码显示
- `twilio`: Twilio 官方 SDK

---

## 七、安全与合规

### 风险等级

| 模式 | 风险等级 | 说明 |
|-----|---------|-----|
| 手动录入 | 🟢 **低** | 完全合规 |
| 扫码登录 | 🔴 **高** | 违反 WhatsApp 服务条款 |
| 官方 API | 🟢 **低** | 官方授权 |

### 合规建议

1. **生产环境**：仅使用手动录入或官方 API
2. **测试环境**：可以使用扫码登录验证需求
3. **数据隐私**：所有消息数据按 `canSeeOwner` 权限隔离
4. **审计日志**：建议记录所有绑定操作

### 免责声明

使用 **扫码登录模式** 导致的账号封禁、数据丢失等后果，由用户自行承担。GoodJob CRM 已在界面上明确标注风险警告。

---

## 八、后续规划

### 短期（1-2 周）
- [ ] 添加媒体消息支持（图片、文件）
- [ ] 优化二维码显示（使用 canvas 渲染）
- [ ] 添加连接状态实时推送（WebSocket）

### 中期（1-2 月）
- [ ] 支持更多官方 API 提供商（Vonage、MessageBird）
- [ ] 添加消息模板管理
- [ ] 实现消息群发功能（仅官方 API）

### 长期（3-6 月）
- [ ] WhatsApp Business Profile 管理
- [ ] 自动化回复规则
- [ ] 客户意向 AI 分析

---

## 联系与反馈

如有问题或建议，请通过以下方式联系：

- **项目仓库**：查看 `WHATSAPP_INTEGRATION_DESIGN.md`
- **技术支持**：联系系统管理员
- **功能建议**：提交到产品需求池

---

**文档版本**：v1.0  
**更新时间**：2026-07-12  
**作者**：GoodJob CRM 开发团队

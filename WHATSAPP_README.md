# WhatsApp 双模式绑定 - 快速开始

## 🎉 功能已实现

**完成时间**：2026-07-12  
**状态**：✅ 编译通过，可直接使用

---

## 📋 实现内容

### 三种绑定模式

1. **手动录入** - 默认模式，零风险
2. **扫码登录** - WhatsApp Web 协议，⚠️ 有封号风险
3. **官方 API** - Twilio 集成，企业级方案

---

## 🚀 快速开始

### 1. 启动项目

```bash
cd ~/Desktop/GoodJob/CRM

# 方式一：同时启动前后端
npm run dev

# 方式二：分别启动
cd backend && npm run dev          # 后端: http://localhost:3000
cd frontend && npm run dev         # 前端: http://localhost:5173
```

### 2. 使用手动录入模式（推荐）

1. 登录 CRM
2. 进入 **WhatsApp · 聊天** 页面
3. 选择客户
4. 右侧选择 **"手动录入"** 模式
5. 输入客户 WhatsApp 号码
6. 开始录入对话

✅ **零风险，立即可用**

### 3. 使用扫码登录模式（⚠️ 测试账号）

1. 选择 **"扫码登录"** 模式
2. 点击 **"开始扫码绑定"**
3. 用手机 WhatsApp 扫描二维码
4. 等待连接成功

⚠️ **警告**：有封号风险，仅用于测试！

### 4. 使用 Twilio API 模式（需配置）

#### 配置环境变量

创建 `.env` 文件：

```env
TWILIO_ACCOUNT_SID=ACxxxxx
TWILIO_AUTH_TOKEN=xxxxx
TWILIO_WEBHOOK_URL=https://your-domain.com/api/whatsapp/webhook/twilio
```

#### 使用步骤

1. 选择 **"官方API (Twilio)"** 模式
2. 输入 Twilio 分配的号码
3. 点击 **"配置 Twilio"**

✅ **零风险，企业级方案**

---

## 📚 文档

| 文档 | 说明 |
|------|------|
| [WHATSAPP_BINDING_GUIDE.md](WHATSAPP_BINDING_GUIDE.md) | 📖 详细使用指南（推荐阅读） |
| [WHATSAPP_IMPLEMENTATION_SUMMARY.md](WHATSAPP_IMPLEMENTATION_SUMMARY.md) | 🔧 技术实现总结 |
| [WHATSAPP_INTEGRATION_DESIGN.md](WHATSAPP_INTEGRATION_DESIGN.md) | 📝 原设计文档 |

---

## ⚠️ 重要提醒

### 封号风险

**扫码登录模式** 使用非官方协议，可能导致账号被封！

| 使用场景 | 推荐模式 |
|---------|---------|
| 正式环境 | ✅ 手动录入 或 官方API |
| 测试验证 | ⚠️ 扫码登录（测试账号） |
| 企业应用 | ✅ 官方API (Twilio) |

界面已有明确的风险警告提示。

---

## 🛠️ 技术栈

- **后端**：Node.js + TypeScript + Express
- **前端**：TypeScript + Vite
- **数据库**：MySQL
- **WhatsApp**：
  - `whatsapp-web.js` - Web 协议
  - `twilio` - 官方 API SDK

---

## 📁 核心文件

```
backend/
  src/
    whatsapp-service.ts          # WhatsApp 服务管理器（新建）
    server.ts                    # API 端点（新增 8 个）
    types.ts                     # 类型定义（扩展）
    mysql-store.ts               # 数据库（扩展）

frontend/
  src/
    prototype-api.ts             # 前端界面（重构）

docs/
  WHATSAPP_BINDING_GUIDE.md      # 使用指南（新建）
  WHATSAPP_IMPLEMENTATION_SUMMARY.md  # 实现总结（新建）
```

---

## 🧪 测试建议

### 测试手动录入
```
✓ 绑定号码
✓ 录入消息
✓ 自动翻译（非中文）
✓ 手动翻译
✓ 删除消息
```

### 测试扫码登录（⚠️ 使用测试账号）
```
✓ 启动扫码
✓ 显示二维码
✓ 扫码连接
✓ 检查连接状态
✓ 发送消息
✓ 断开连接
```

### 测试 Twilio API（需配置）
```
✓ 配置环境变量
✓ 绑定 Twilio 号码
✓ 发送消息
✓ 接收消息（Webhook）
```

---

## 📊 API 端点

### 原有端点（手动录入）
- `GET /api/whatsapp/threads` - 聊天列表
- `GET /api/whatsapp/customers/:id/messages` - 消息记录
- `POST /api/whatsapp/customers/:id/binding` - 绑定号码
- `POST /api/whatsapp/customers/:id/messages` - 录入消息
- `POST /api/whatsapp/messages/:id/translate` - 翻译
- `DELETE /api/whatsapp/messages/:id` - 删除

### 新增端点（双模式）
- `GET /api/whatsapp/binding-modes` - 可用模式
- `POST /api/whatsapp/binding/web-scan/start` - 启动扫码
- `GET /api/whatsapp/binding/web-scan/qr/:clientId` - 获取二维码
- `GET /api/whatsapp/binding/web-scan/status/:clientId` - 连接状态
- `POST /api/whatsapp/binding/web-scan/disconnect` - 断开连接
- `POST /api/whatsapp/binding/twilio/start` - 配置 Twilio
- `POST /api/whatsapp/webhook/twilio` - Twilio Webhook

---

## 🔐 安全说明

### 数据隔离
- ✅ 所有 API 接入 `canSeeOwner` 权限控制
- ✅ 用户只能访问自己的客户数据

### 会话安全
- ✅ Web 扫码会话数据自动清理
- ✅ Twilio Webhook 签名验证

### 风险提示
- 🔴 扫码模式：界面明确警告封号风险
- ✅ 官方API：合规安全
- ✅ 手动录入：零风险

---

## 💡 常见问题

**Q: 扫码后多久会被封号？**  
A: 无法预测，建议仅用于测试环境。

**Q: Twilio 需要多少费用？**  
A: 约 $70-120/月（10人团队）。

**Q: 可以同时使用多种模式吗？**  
A: 每个客户一种模式，不同客户可用不同模式。

**Q: 如何切换模式？**  
A: 在绑定界面直接选择即可。

---

## 🎯 后续规划

- [ ] 媒体消息支持（图片、文件）
- [ ] Canvas 二维码渲染
- [ ] WebSocket 推送状态
- [ ] 消息模板管理
- [ ] 更多 BSP 支持

---

## 👨‍💻 开发者

**实现者**：Kiro AI  
**完成时间**：2026-07-12  
**项目**：GoodJob CRM

---

## 📝 许可

本功能遵循项目主许可证。

---

**🎉 现在就开始使用 WhatsApp 双模式绑定功能吧！**

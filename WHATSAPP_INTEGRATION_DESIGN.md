# WhatsApp 集成设计方案（GoodJob CRM）

> 三方辩论（产品 / 设计 / 外贸业务）产出，分阶段落地。核心原则：**风控第一，只走官方合规路径，绝不使用非官方库（Baileys / whatsapp-web.js），杜绝封号。**

---

## 一、方案选型（调研结论）

| 方案 | 封号风险 | 成本 | 结论 |
|---|---|---|---|
| WhatsApp Business API（官方 + BSP 如 Twilio） | ✅ 极低 | ??💰 中 | **推荐**，阶段1采用 |
| WhatsApp Business App（纯人工） | ✅ 无 | 💰 免费 | 阶段0过渡 |
| 非官方库（Baileys 等，逆向 Web 协议） | 🔴 **高** | 免费但毁灭性风险 | **禁用（红线）** |

---

## 二、分阶段路线

```
阶段 0（已完成 ✅）：手动录入 + 自动翻译 + 聊天中心 UI
  └ 零封号风险，验证需求
阶段 1（需用户先申请账号）：Twilio WhatsApp Business API
  └ webhook 实时收发 / 模板消息 / 已读回执
阶段 2（规模化）：自建 BSP 降成本 + AI 意向提取 + 多人协作
```

---

## 三、阶段 0 已交付内容（本次实现）

### 后端
- **新增表**：`whatsapp_bindings`（客户↔号码绑定）、`whatsapp_messages`（对话记录，含 `content_translated` 翻译字段）
- **6 个 API**（均接入 `canSeeOwner` 数据权限隔离）：
  | 方法 | 路径 | 说明 |
  |---|---|---|
  | GET | `/api/whatsapp/threads` | 聊天中心会话聚合 |
  | GET | `/api/whatsapp/customers/:id/messages` | 某客户对话+绑定 |
  | POST | `/api/whatsapp/customers/:id/binding` | 绑定/更新号码 |
  | POST | `/api/whatsapp/customers/:id/messages` | 录入对话（非中文自动翻译） |
  | POST | `/api/whatsapp/messages/:id/translate` | 手动重译 |
  | DELETE | `/api/whatsapp/messages/:id` | 删除记录 |
- **翻译**：复用现有 `callAiModel`。非中文→翻译成中文；中文→跳过；无 AI 模型→优雅降级不阻断。

### 前端（原型 prototype-api.ts + index.html）
- 导航新增「WhatsApp · 聊天」页签
- **三栏聊天中心**：左=会话列表(未读红点/搜索)，中=WhatsApp 风格气泡对话(非中文下方灰色斜体译文)，右=客户卡片+号码绑定+风控提示
- 录入即时刷新、Enter 发送、翻译按钮

### 自测结论
后端/前端 tsc、前端生产构建、后端自测回归全绿；API 全流程（绑定→收发→聚合→翻译分支）英/中/日多语言验证通过。

---

## 四、阶段 1 待启动（阻塞项：需用户提供）

1. **WhatsApp Business 账号**：建议公司统一申请**一个企业号**（支持多人协作共享聊天历史），而非每人各自 Business App。
2. **Twilio 账号 + 凭证**（Account SID / Auth Token / WhatsApp 发信号）。
3. **合规准备**：营业执照、公司域名、隐私政策页（Meta 审核需要）。

### 阶段 1 技术要点
- Webhook 接收：Twilio → `/api/whatsapp/webhook` → 匹配手机号关联客户 → 入库 → WebSocket 推前端
- 发送：CRM → Twilio API → 客户
- **合规限制**：首次联系必须用**预审模板消息**（非自由文本），不可群发营销
- 成本估算：~$120/月起（10 销售，日均 20 条对话）

---

## 五、操作闭环（已验证 ✅）
录入/接收 → 自动翻译 → 聚合到聊天中心 → 回复 → 记录留痕 → 按客户权限隔离。

## 六、风控清单
| 风险 | 措施 |
|---|---|
| 封号 | 禁用非官方库；阶段0纯手动；阶段1只走官方 API |
| 翻译误差 | 译文标注为机器翻译；重要消息人工复核 |
| 隐私泄露 | `canSeeOwner` 按归属隔离 |

---
*落档时间：2026-07-12｜阶段0已实现并自测通过。*

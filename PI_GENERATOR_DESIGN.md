# PI 报价单生成器 — 后端设计方案

> **状态**: 设计阶段  
> **作者**: WorkBuddy  
> **日期**: 2026-08-01  
> **关联**: [交互原型](../frontend/PI报价单生成器-原型.html)

---

## 1. 概述

### 1.1 目标

为外贸 B2B 场景提供一键生成多语言、多币种、多贸易术语的形式发票（Proforma Invoice, PI）能力，并支持通过 WhatsApp 直发客户。

### 1.2 核心价值

- 业务员从商机或客户详情页一键生成品牌 PI，省去手工排版
- 实时切换语言（EN/ES/RU/AR/ZH）、币种（USD/EUR/CNY/GBP）、Incoterms（EXW/FOB/CIF/DAP）
- 阿拉伯语自动 RTL 排版
- PDF 一键导出，WhatsApp 一键发送
- 报价历史留痕，支持版本对比与重新发送

### 1.3 用户场景

```
商机详情 → [生成 PI] → 配置预览 → 导出 PDF / 发 WhatsApp → 客户确认 → 转正式订单
```

---

## 2. 数据模型

### 2.1 新增表

```sql
-- PI 报价单主表
CREATE TABLE IF NOT EXISTS pi_documents (
  id              VARCHAR(64) PRIMARY KEY,
  pi_number       VARCHAR(40) NOT NULL UNIQUE,          -- PI-2026-0847
  deal_id         VARCHAR(64) DEFAULT '',                -- 关联商机（可选）
  customer_id     VARCHAR(64) NOT NULL,                  -- 关联客户
  owner_id        VARCHAR(64) NOT NULL,
  team_id         VARCHAR(64) NOT NULL,

  -- 多语言/多币种
  language        VARCHAR(8) NOT NULL DEFAULT 'en',      -- en/es/ru/ar/zh
  currency        VARCHAR(8) NOT NULL DEFAULT 'USD',     -- USD/EUR/CNY/GBP
  incoterms       VARCHAR(10) NOT NULL DEFAULT 'EXW',    -- EXW/FOB/CIF/DAP
  port            VARCHAR(120) DEFAULT '',

  -- 条款
  payment_terms   VARCHAR(40) NOT NULL DEFAULT 'tt30',   -- tt30/tt50/tt100/lc/oa30
  delivery_time   VARCHAR(120) DEFAULT '',
  validity_days   INT DEFAULT 30,

  -- 金额（冗余存储，避免行项目丢失后无法审计）
  subtotal        DECIMAL(14,2) DEFAULT 0,
  discount_total  DECIMAL(14,2) DEFAULT 0,
  grand_total     DECIMAL(14,2) DEFAULT 0,
  amount_in_words VARCHAR(500) DEFAULT '',

  -- 买方快照（PI 是独立单据，客户改了信息不影响历史 PI）
  buyer_name      VARCHAR(200) NOT NULL,
  buyer_address   TEXT,
  buyer_contact   VARCHAR(200) DEFAULT '',
  buyer_whatsapp  VARCHAR(40) DEFAULT '',

  -- 状态
  status          VARCHAR(20) NOT NULL DEFAULT 'draft',  -- draft/sent/viewed/accepted/expired/archived
  pdf_path        VARCHAR(500) DEFAULT '',               -- 已生成 PDF 的文件路径
  pdf_generated_at TIMESTAMP NULL,

  -- WhatsApp 投递
  whatsapp_sent_at  TIMESTAMP NULL,
  whatsapp_msg_id   VARCHAR(200) DEFAULT '',

  -- 版本
  version         INT DEFAULT 1,
  parent_pi_id    VARCHAR(64) DEFAULT '',                -- 修订时指向原 PI

  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_pi_customer(customer_id),
  INDEX idx_pi_deal(deal_id),
  INDEX idx_pi_owner(owner_id),
  INDEX idx_pi_status(status),
  INDEX idx_pi_team(team_id)
);

-- PI 行项目
CREATE TABLE IF NOT EXISTS pi_line_items (
  id              VARCHAR(64) PRIMARY KEY,
  pi_id           VARCHAR(64) NOT NULL,
  seq             INT NOT NULL DEFAULT 1,

  product_id      VARCHAR(64) DEFAULT '',                -- 关联产品库（可选）
  description     VARCHAR(300) NOT NULL,                 -- 产品名称（快照）
  model           VARCHAR(200) DEFAULT '',               -- 型号
  hs_code         VARCHAR(40) DEFAULT '',                -- 海关编码
  quantity        DECIMAL(14,2) NOT NULL DEFAULT 0,
  unit            VARCHAR(20) NOT NULL DEFAULT 'PCS',
  unit_price      DECIMAL(14,4) NOT NULL DEFAULT 0,
  discount_pct    DECIMAL(5,2) DEFAULT 0,                -- 行折扣百分比
  line_total      DECIMAL(14,2) GENERATED ALWAYS AS (quantity * unit_price * (1 - discount_pct/100)) STORED,

  INDEX idx_pili_pi(pi_id)
);

-- PI 模板（公司级/团队级品牌模板）
CREATE TABLE IF NOT EXISTS pi_templates (
  id              VARCHAR(64) PRIMARY KEY,
  team_id         VARCHAR(64) NOT NULL,
  name            VARCHAR(100) NOT NULL,                 -- "默认模板" / "中东市场模板"
  is_default      BOOLEAN DEFAULT FALSE,

  -- 卖方信息
  seller_name     VARCHAR(200) NOT NULL,
  seller_address  TEXT,
  seller_phone    VARCHAR(60) DEFAULT '',
  seller_email    VARCHAR(160) DEFAULT '',
  seller_website  VARCHAR(255) DEFAULT '',
  seller_whatsapp VARCHAR(40) DEFAULT '',

  -- 银行信息
  bank_name       VARCHAR(200) DEFAULT '',
  bank_account_name VARCHAR(200) DEFAULT '',
  bank_account_no VARCHAR(60) DEFAULT '',
  bank_swift      VARCHAR(20) DEFAULT '',

  -- Logo
  logo_url        VARCHAR(500) DEFAULT '',

  -- 自定义条款（JSON，按 language 键存储）
  custom_terms    JSON,

  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_pit_team(team_id)
);
```

### 2.2 与现有表的集成

| 现有表 | 集成点 |
|---|---|
| `customers` | 买方信息自动填充（company/billing_name/billing_address/whatsapp/phone/email/default_port_discharge）|
| `deals` | 商机行项目预填 PI 行项目（product/quantity/unit_price）；PI 创建后回写 deal 的 `next_action` |
| `products` | 产品搜索器自动填充 description/model/hs_code/unit/price |
| `customer_activities` | PI 发送/查看/接受 自动写入客户活动时间线 |
| `deal_events` | PI 状态变更写入商机事件流 |

---

## 3. API 设计

### 3.1 PI CRUD

```
POST   /api/v1/pi                    创建 PI（从商机/客户/空白创建）
GET    /api/v1/pi                    列表（支持 ?customerId=&dealId=&status=&page=）
GET    /api/v1/pi/:id                获取 PI 详情（含行项目）
PUT    /api/v1/pi/:id                更新 PI（仅 draft 状态可改）
DELETE /api/v1/pi/:id                删除（软删除，archived）
```

### 3.2 PI 操作

```
POST   /api/v1/pi/:id/preview        生成预览 HTML（带指定语言/币种参数）
POST   /api/v1/pi/:id/pdf            生成 PDF，返回文件流或 URL
POST   /api/v1/pi/:id/send-whatsapp  通过 whatsapp-plugin 发送 PI（PDF 附件 + 摘要消息）
POST   /api/v1/pi/:id/revise         创建修订版本（version+1，parent_pi_id 指向原 PI）
GET    /api/v1/pi/:id/versions       获取版本历史
```

### 3.3 模板管理

```
GET    /api/v1/pi-templates          列表
POST   /api/v1/pi-templates          创建
PUT    /api/v1/pi-templates/:id      更新
DELETE /api/v1/pi-templates/:id      删除
```

### 3.4 请求/响应示例

**创建 PI（从商机）**

```http
POST /api/v1/pi
Content-Type: application/json

{
  "dealId": "deal_abc123",
  "customerId": "cus_xyz789",
  "language": "en",
  "currency": "USD",
  "incoterms": "FOB",
  "port": "Shenzhen, China",
  "paymentTerms": "tt30",
  "deliveryTime": "15-20 days after deposit",
  "validityDays": 30,
  "items": [
    {
      "productId": "prod_001",
      "description": "Industrial LED Flood Light 200W",
      "model": "GJ-FL-200W",
      "hsCode": "9405.42",
      "quantity": 500,
      "unit": "PCS",
      "unitPrice": 28.50,
      "discountPct": 5
    }
  ]
}
```

```json
{
  "id": "pi_2026_0847",
  "piNumber": "PI-2026-0847",
  "status": "draft",
  "subtotal": 14250.00,
  "discountTotal": 712.50,
  "grandTotal": 13537.50,
  "amountInWords": "US Dollars 13,537 and 50/100 only",
  "validUntil": "2026-08-31",
  "items": [...],
  "createdAt": "2026-08-01T10:30:00Z"
}
```

---

## 4. PDF 生成管线

### 4.1 技术选型

```
PI 数据 (JSON)
    │
    ▼
HTML 模板渲染 (Nunjucks/Handlebars)
    │  ← 注入 i18n 字典 + 模板品牌信息
    ▼
Puppeteer / Playwright headless Chrome
    │  ← A4 页面、@media print CSS
    ▼
PDF Buffer → 写入 /uploads/pi/{piNumber}_v{version}.pdf
    │
    ▼
更新 pi_documents.pdf_path + pdf_generated_at
```

**选型理由**: 复用现有 `whatsapp-plugin` 的 Puppeteer 依赖（已安装），无需引入新依赖；HTML→PDF 路线支持复杂排版（RTL、多语言字体、品牌 Logo）且所见即所得。

### 4.2 字体策略

| 语言 | 字体 | 来源 |
|---|---|---|
| EN/ES | Noto Sans (system fallback) | 系统内置 |
| RU | Noto Sans (Cyrillic subset) | 系统内置 |
| AR | Noto Naskh Arabic | 需安装 `@fontsource/noto-naskh-arabic` |
| ZH | PingFang SC / Noto Sans SC | 系统内置 |

Puppeteer 启动时通过 `--font-render-hinting=none` 确保跨平台一致性。

### 4.3 PDF 内容结构

```
┌──────────────────────────────────────┐
│  [Logo]    GoodJob Industrial        │
│            PROFORMA INVOICE           │  ← letterhead
│            PI-2026-0847               │
├──────────────────────────────────────┤
│  TO: Buyer Info    FROM: Seller Info  │  ← parties
├──────────────────────────────────────┤
│  DATE | VALID UNTIL | CURRENCY        │  ← meta grid
├──────────────────────────────────────┤
│  No. | Description | Model | HS |    │
│       Qty | Unit | Price | Amount     │  ← line items table
├──────────────────────────────────────┤
│                    Subtotal    $X     │
│                    Discount    $Y     │  ← totals
│                    GRAND TOTAL  $Z    │
├──────────────────────────────────────┤
│  Say total: US Dollars X only         │  ← amount in words
├──────────────────────────────────────┤
│  Incoterms | Payment | Delivery | Port│  ← terms grid
├──────────────────────────────────────┤
│  Bank Details                         │  ← bank block
├──────────────────────────────────────┤
│  [Signature]         [Company Stamp]  │  ← signature
└──────────────────────────────────────┘
```

---

## 5. WhatsApp 投递

### 5.1 流程

```
用户点击"发送 WhatsApp"
    │
    ▼
后端确认 PDF 已生成（未生成则先触发 PDF 管线）
    │
    ▼
调用 whatsapp-plugin API 发送：
  1. PDF 文件附件
  2. 摘要消息（PI 编号 + 总金额 + Incoterms + 付款条款 + 有效期）
    │
    ▼
whatsapp-plugin 返回 messageId → 存入 pi_documents.whatsapp_msg_id
    │
    ▼
写入 customer_activities: { type: 'pi_sent', pi_id, whatsapp_msg_id }
    │
    ▼
更新 pi_documents.status = 'sent', whatsapp_sent_at = NOW()
```

### 5.2 摘要消息模板（按语言）

```
🧾 *Proforma Invoice {piNumber}*

*Grand Total:* {grandTotal}
*Incoterms:* {incoterms}
*Payment:* {paymentTerms}
*Valid Until:* {validUntil}

PDF attached. Please review and confirm.

— GoodJob Industrial Co., Ltd.
```

### 5.3 已读/查看追踪

whatsapp-plugin 的 webhook 收到消息状态回调时，若 `whatsapp_msg_id` 匹配某条 PI，则更新其状态：
- `delivered` → 保持 `sent`
- `read` → `status = 'viewed'`
- 客户回复确认关键词 → `status = 'accepted'`（需配置关键词规则）

---

## 6. i18n 与多币种

### 6.1 i18n 字典

所有 PI 标签、列头、条款文本存储在后端 `i18n/pi-labels.json`，按语言代码索引：

```json
{
  "en": { "title": "PROFORMA INVOICE", "to": "TO", ... },
  "es": { "title": "FACTURA PROFORMA", "to": "PARA", ... },
  "ru": { "title": "ПРОФОРМА-СЧЕТ", "to": "КОМУ", ... },
  "ar": { "title": "فاتورة مبدئية", "to": "إلى", ... },
  "zh": { "title": "形式发票", "to": "收货方", ... }
}
```

### 6.2 多币种处理

- 金额存储使用 `DECIMAL(14,2)`，始终以 PI 指定的 `currency` 为单位
- 前端/PDF 格式化使用 `Intl.NumberFormat` 按币种 locale 格式化
- 汇率换算**不在 PI 内做**（PI 是报价快照，不随汇率波动）；如需换算报价，在创建时算好目标币种金额后存入

### 6.3 RTL 处理

- 阿拉伯语（`language = 'ar'`）时，HTML 模板根节点设置 `dir="rtl"`
- CSS 使用逻辑属性（`margin-inline-start` 替代 `margin-left`）或通过 `[dir="rtl"]` 选择器覆盖
- Puppeteer 渲染时确保 `--lang=ar` 参数传入

---

## 7. 权限与审计

### 7.1 权限矩阵

| 角色 | 查看 | 创建 | 编辑 | 发送 | 删除 |
|---|---|---|---|---|---|
| Owner | 自己+下属 | ✅ | 自己创建的 | ✅ | 自己创建的 |
| Admin | 团队全部 | ✅ | 团队全部 | ✅ | 团队全部 |
| Member | 自己创建的 | ✅ | 自己创建的 | ✅ | ❌ |

### 7.2 审计

所有 PI 操作写入 `deal_events`（如关联了商机）和 `customer_activities`：

| 事件类型 | 说明 |
|---|---|
| `pi_created` | 创建 PI |
| `pi_updated` | 修改 PI |
| `pi_pdf_generated` | 生成 PDF |
| `pi_sent` | 发送 WhatsApp |
| `pi_viewed` | 客户查看（whatsapp webhook 回调） |
| `pi_accepted` | 客户接受 |
| `pi_revised` | 创建修订版本 |
| `pi_archived` | 归档 |

---

## 8. PI 编号规则

```
PI-{YYYY}-{序号4位}
例: PI-2026-0847
```

- 序号按团队递增，每年重置
- 使用 Redis `INCR` 或 MySQL `SELECT ... FOR UPDATE` 确保并发安全
- 支持自定义前缀（模板配置）

---

## 9. 分期交付

### Phase 1 — MVP（2 周）

- [ ] 数据模型 + migration
- [ ] PI CRUD API（创建/列表/详情/更新/删除）
- [ ] 前端集成：商机详情页"生成 PI"按钮 → PI 编辑器抽屉
- [ ] i18n 字典（5 语言）
- [ ] PDF 生成（Puppeteer）
- [ ] 基础 WhatsApp 发送（PDF 附件 + 摘要消息）

### Phase 2 — 增强（1.5 周）

- [ ] 模板管理（多模板、品牌自定义）
- [ ] 修订版本 + 版本对比
- [ ] WhatsApp 已读/查看状态追踪
- [ ] PI 列表页（按客户/商机/状态筛选）
- [ ] 产品搜索器（输入关键词自动填充行项目）

### Phase 3 — 智能化（1 周）

- [ ] 基于历史成单价格自动推荐单价
- [ ] Incoterms 自动计算（FOB→CIF 自动加运费+保险费）
- [ ] 多语言自动翻译（产品描述 zh→en/es/ru/ar）
- [ ] PI 接受后一键转正式订单/合同

---

## 10. 技术约束与风险

| 约束/风险 | 对策 |
|---|---|
| Puppeteer 在生产环境的内存占用 | 单实例复用 browser，每次创建 page；超时 30s 自动 kill |
| 阿拉伯语字体在 Linux 服务器缺失 | Docker 镜像预装 `fonts-noto-naskh-arabic` |
| WhatsApp 发送频率限制 | 队列化发送，间隔 ≥3s；失败自动重试 3 次 |
| PDF 文件存储 | 开发期存本地 `/uploads/pi/`；生产期对接对象存储 |
| 并发 PI 编号冲突 | MySQL `FOR UPDATE` 行锁或 Redis 原子递增 |

---

## 11. 文件结构

```
backend/src/
  pi/
    pi-router.ts          # 路由
    pi-service.ts         # 业务逻辑
    pi-store.ts           # MySQL 持久化
    pdf-generator.ts      # Puppeteer PDF 管线
    pi-i18n.ts            # i18n 字典加载
    pi-templates/
      default-en.html     # HTML 模板（按语言）
      default-ar.html     # 阿拉伯语 RTL 模板
      ...
  uploads/pi/             # PDF 文件存储

frontend/src/
  pi-generator.ts         # PI 编辑器组件（抽屉/模态）
  pi-list.ts              # PI 列表页

i18n/
  pi-labels.json          # PI 多语言标签
```

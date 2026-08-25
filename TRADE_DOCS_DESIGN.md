# 外贸全单证管理系统 — 后端设计方案

> **状态**: 设计阶段  
> **作者**: WorkBuddy  
> **日期**: 2026-08-01  
> **关联**: [交互原型](../frontend/外贸单证管理系统.html)

---

## 1. 概述

### 1.1 目标

为外贸 B2B 场景提供统一的单证生成与管理平台，覆盖从报价到装运的全链路单证需求。

### 1.2 支持的单证类型（7 种）

| 代码 | 中文名 |英文名 | 用途 |
|---|---|---|---|
| `pi` | 形式发票 | Proforma Invoice | 报价阶段 |
| `ci` | 商业发票 | Commercial Invoice | 清关用 |
| `pl` | 装箱单 | Packing List | 装箱明细 |
| `contract` | 销售合同 | Sales Contract | 正式合同 |
| `quotation` | 报价单 | Quotation | 产品报价 |
| `coo` | 原产地证 | Certificate of Origin | 产地证明 |
| `shipping` | 装运通知 | Shipping Advice | 装运告知 |

### 1.3 核心特性

- **多语言**: EN / ES / RU / AR (RTL) / ZH，所有标签、条款、列头自动翻译
- **多主题**: Indigo / Emerald / Rose / Slate / Amber，一键切换品牌色系
- **多币种**: USD / EUR / CNY / GBP，按 locale 格式化
- **多数据源**: 商机 / 产品库 / 客户 / 手动输入
- **多 Incoterms**: EXW / FOB / CIF / DAP
- **PDF 一键导出** + **WhatsApp 直发**
- **版本管理** + **状态追踪** + **自测面板**

---

## 2. 数据模型

### 2.1 统一单证表

```sql
CREATE TABLE IF NOT EXISTS trade_documents (
  id              VARCHAR(64) PRIMARY KEY,
  doc_number      VARCHAR(40) NOT NULL UNIQUE,
  doc_type        VARCHAR(20) NOT NULL,              -- pi/ci/pl/contract/quotation/coo/shipping
  customer_id     VARCHAR(64) DEFAULT '',
  deal_id         VARCHAR(64) DEFAULT '',
  owner_id        VARCHAR(64) NOT NULL,
  team_id         VARCHAR(64) NOT NULL,

  -- 多语言/多币种/多主题
  language        VARCHAR(8) NOT NULL DEFAULT 'en',
  currency        VARCHAR(8) NOT NULL DEFAULT 'USD',
  theme           VARCHAR(20) NOT NULL DEFAULT 'indigo',
  incoterms       VARCHAR(10) NOT NULL DEFAULT 'FOB',
  port            VARCHAR(120) DEFAULT '',

  -- 条款
  payment_terms   VARCHAR(40) DEFAULT 'tt30',
  delivery_time   VARCHAR(120) DEFAULT '',
  validity_days   INT DEFAULT 30,

  -- 金额
  subtotal        DECIMAL(14,2) DEFAULT 0,
  discount_total  DECIMAL(14,2) DEFAULT 0,
  grand_total     DECIMAL(14,2) DEFAULT 0,
  amount_in_words VARCHAR(500) DEFAULT '',

  -- 重量/包装 (装箱单/装运通知用)
  total_nw        DECIMAL(14,2) DEFAULT 0,
  total_gw        DECIMAL(14,2) DEFAULT 0,
  total_ctn       INT DEFAULT 0,

  -- 买方快照
  buyer_name      VARCHAR(200) DEFAULT '',
  buyer_address   TEXT,
  buyer_contact   VARCHAR(200) DEFAULT '',
  buyer_whatsapp  VARCHAR(40) DEFAULT '',

  -- 装运信息 (装运通知用)
  vessel          VARCHAR(200) DEFAULT '',
  bl_number       VARCHAR(100) DEFAULT '',
  container_no    VARCHAR(100) DEFAULT '',
  etd             DATE NULL,
  eta             DATE NULL,

  -- 状态
  status          VARCHAR(20) NOT NULL DEFAULT 'draft',
  pdf_path        VARCHAR(500) DEFAULT '',
  pdf_generated_at TIMESTAMP NULL,
  whatsapp_sent_at  TIMESTAMP NULL,
  whatsapp_msg_id   VARCHAR(200) DEFAULT '',

  -- 版本
  version         INT DEFAULT 1,
  parent_doc_id   VARCHAR(64) DEFAULT '',

  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_td_type(doc_type),
  INDEX idx_td_customer(customer_id),
  INDEX idx_td_deal(deal_id),
  INDEX idx_td_owner(owner_id),
  INDEX idx_td_status(status),
  INDEX idx_td_team(team_id)
);
```

### 2.2 单证行项目表

```sql
CREATE TABLE IF NOT EXISTS trade_doc_items (
  id              VARCHAR(64) PRIMARY KEY,
  doc_id          VARCHAR(64) NOT NULL,
  seq             INT NOT NULL DEFAULT 1,
  product_id      VARCHAR(64) DEFAULT '',
  description     VARCHAR(300) NOT NULL,
  model           VARCHAR(200) DEFAULT '',
  hs_code         VARCHAR(40) DEFAULT '',
  quantity        DECIMAL(14,2) NOT NULL DEFAULT 0,
  unit            VARCHAR(20) NOT NULL DEFAULT 'PCS',
  unit_price      DECIMAL(14,4) DEFAULT 0,
  discount_pct    DECIMAL(5,2) DEFAULT 0,
  line_total      DECIMAL(14,2) DEFAULT 0,
  nw_kg           DECIMAL(14,2) DEFAULT 0,           -- 净重
  gw_kg           DECIMAL(14,2) DEFAULT 0,           -- 毛重
  ctn_count       INT DEFAULT 1,                     -- 件数
  INDEX idx_tdi_doc(doc_id)
);
```

### 2.3 单证模板表

```sql
CREATE TABLE IF NOT EXISTS trade_doc_templates (
  id              VARCHAR(64) PRIMARY KEY,
  team_id         VARCHAR(64) NOT NULL,
  name            VARCHAR(100) NOT NULL,
  doc_type        VARCHAR(20) NOT NULL DEFAULT 'pi',
  theme           VARCHAR(20) NOT NULL DEFAULT 'indigo',
  is_default      BOOLEAN DEFAULT FALSE,
  seller_name     VARCHAR(200) NOT NULL,
  seller_address  TEXT,
  seller_phone    VARCHAR(60) DEFAULT '',
  seller_email    VARCHAR(160) DEFAULT '',
  seller_website  VARCHAR(255) DEFAULT '',
  seller_whatsapp VARCHAR(40) DEFAULT '',
  bank_name       VARCHAR(200) DEFAULT '',
  bank_acct_name  VARCHAR(200) DEFAULT '',
  bank_acct_no    VARCHAR(60) DEFAULT '',
  bank_swift      VARCHAR(20) DEFAULT '',
  logo_url        VARCHAR(500) DEFAULT '',
  custom_terms    JSON,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tdt_team(team_id)
);
```

### 2.4 与现有表的集成

| 现有表 | 集成点 |
|---|---|
| `customers` | 买方信息自动填充 (company/billing_name/billing_address/whatsapp/phone/email/default_port_discharge) |
| `deals` | 商机行项目预填单证行项目 (product/quantity/unit_price)；单证创建后回写 deal 的 next_action |
| `products` | 产品搜索器自动填充 (description/model/hs_code/unit/price/weight) |
| `customer_activities` | 单证发送/查看/接受 写入客户活动时间线 |
| `deal_events` | 单证状态变更写入商机事件流 |
| `shipments` | 装运通知可关联 shipment 记录，自动填 vessel/bl_number/container_no/etd/eta |

---

## 3. API 设计

### 3.1 单证 CRUD

```
POST   /api/v1/trade-docs              创建单证（指定 doc_type + 数据源）
GET    /api/v1/trade-docs              列表（?docType=&customerId=&dealId=&status=&page=）
GET    /api/v1/trade-docs/:id          获取单证详情（含行项目）
PUT    /api/v1/trade-docs/:id          更新单证（仅 draft 可改）
DELETE /api/v1/trade-docs/:id          删除（软删除 archived）
```

### 3.2 单证操作

```
POST   /api/v1/trade-docs/:id/preview       生成预览 HTML（?language=&currency=&theme=）
POST   /api/v1/trade-docs/:id/pdf           生成 PDF
POST   /api/v1/trade-docs/:id/send-whatsapp 通过 whatsapp-plugin 发送
POST   /api/v1/trade-docs/:id/revise        创建修订版本
GET    /api/v1/trade-docs/:id/versions      获取版本历史
POST   /api/v1/trade-docs/:id/convert       单证转换（PI → CI / Quotation → PI）
```

### 3.3 模板管理

```
GET    /api/v1/trade-doc-templates          列表
POST   /api/v1/trade-doc-templates          创建
PUT    /api/v1/trade-doc-templates/:id      更新
DELETE /api/v1/trade-doc-templates/:id      删除
```

### 3.4 数据源 API

```
GET    /api/v1/trade-docs/sources           可用数据源列表
GET    /api/v1/trade-docs/sources/deals     可选商机列表（含行项目预览）
GET    /api/v1/trade-docs/sources/products  可选产品列表
GET    /api/v1/trade-docs/sources/customers 可选客户列表
```

### 3.5 创建请求示例

```http
POST /api/v1/trade-docs
Content-Type: application/json

{
  "docType": "pi",
  "sourceType": "deal",
  "sourceId": "deal_abc123",
  "language": "en",
  "currency": "USD",
  "theme": "indigo",
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
      "discountPct": 5,
      "nwKg": 2.5,
      "ctnCount": 10
    }
  ]
}
```

---

## 4. 多主题系统

### 4.1 主题定义

| 主题 ID | 品牌色 | 适用场景 |
|---|---|---|
| `indigo` | `#3157d5` 深靛蓝 | 默认/正式商务 |
| `emerald` | `#0d9f6e` 翡翠绿 | 新能源/环保行业 |
| `rose` | `#e11d48` 玫红 | 消费品/时尚 |
| `slate` | `#475569` 石板灰 | 工业/重工 |
| `amber` | `#d97706` 琥珀金 | 高端/奢侈 |

### 4.2 实现方式

- 前端通过 `data-theme` 属性在根节点切换 CSS 变量集
- PDF 渲染时通过 Puppeteer 注入对应的 `<style>` 块
- 主题存储在 `trade_documents.theme` 字段，确保 PDF 重生成时一致

---

## 5. PDF 生成管线

### 5.1 架构

```
单证数据 (JSON)
    │
    ├─ 按 doc_type 选择 HTML 模板
    │   ├─ invoice-template.html (PI/CI/Quotation 共用)
    │   ├─ packing-list-template.html
    │   ├─ contract-template.html
    │   ├─ coo-template.html
    │   └─ shipping-advice-template.html
    │
    ├─ 注入 i18n 字典 (按 language)
    ├─ 注入主题 CSS (按 theme)
    ├─ 注入模板品牌信息 (按 template)
    │
    ▼
Puppeteer headless Chrome (A4, print CSS)
    │
    ▼
PDF → /uploads/trade-docs/{doc_number}_v{version}.pdf
    │
    ▼
更新 trade_documents.pdf_path + pdf_generated_at
```

### 5.2 模板复用策略

- PI / CI / Quotation 共用一个基础模板，通过 `doc_type` 参数切换标题和部分字段
- Packing List 去掉价格列，增加重量/包装列
- Contract 使用正式合同格式（编号条款 + 双方签字）
- COO 使用网格布局（产地证明专用格式）
- Shipping Advice 使用信函格式 + 装运信息网格

---

## 6. i18n 与 RTL

### 6.1 i18n 字典

存储在后端 `i18n/trade-doc-labels.json`，按语言代码索引，覆盖：
- 单证标题、列头、标签（共 ~80 个 key）
- Incoterms 描述（4 种 × 5 语言 = 20 条）
- 付款条款描述（5 种 × 5 语言 = 25 条）

### 6.2 RTL 处理

- 阿拉伯语 (`language = 'ar'`) 时，HTML 根节点 `dir="rtl"`
- CSS 使用 `[dir="rtl"]` 选择器覆盖方向相关属性
- Puppeteer 渲染时传入 `--lang=ar`
- 字体：安装 `fonts-noto-naskh-arabic`

---

## 7. 权限与审计

### 7.1 权限矩阵

| 角色 | 查看 | 创建 | 编辑 | 发送 | 删除 |
|---|---|---|---|---|---|
| Owner | 自己+下属 | ✅ | 自己创建的 | ✅ | 自己创建的 |
| Admin | 团队全部 | ✅ | 团队全部 | ✅ | 团队全部 |
| Member | 自己创建的 | ✅ | 自己创建的 | ✅ | ❌ |

### 7.2 审计事件

| 事件类型 | 说明 |
|---|---|
| `trade_doc_created` | 创建单证 |
| `trade_doc_updated` | 修改单证 |
| `trade_doc_pdf_generated` | 生成 PDF |
| `trade_doc_sent` | 发送 WhatsApp |
| `trade_doc_viewed` | 客户查看 |
| `trade_doc_accepted` | 客户接受 |
| `trade_doc_revised` | 创建修订版本 |
| `trade_doc_converted` | 单证类型转换 |
| `trade_doc_archived` | 归档 |

---

## 8. 分期交付

### Phase 1 — MVP（2.5 周）

- [ ] 数据模型 + migration
- [ ] 单证 CRUD API
- [ ] 前端集成：独立单证管理页面
- [ ] 7 种单证模板渲染
- [ ] i18n 字典（5 语言）
- [ ] 5 主题切换
- [ ] 数据源选择（商机/产品/客户/手动）
- [ ] PDF 生成（Puppeteer）
- [ ] WhatsApp 发送

### Phase 2 — 增强（1.5 周）

- [ ] 模板管理（多模板、品牌自定义）
- [ ] 修订版本 + 版本对比
- [ ] 单证转换（PI → CI / Quotation → PI）
- [ ] WhatsApp 已读/查看状态追踪
- [ ] 装运通知关联 shipment 记录

### Phase 3 — 智能化（1 周）

- [ ] 基于历史成单价格自动推荐单价
- [ ] Incoterms 自动计算（FOB → CIF 加运费+保险费）
- [ ] 多语言自动翻译（产品描述 zh → en/es/ru/ar）
- [ ] 单证接受后一键转正式订单

---

## 9. 文件结构

```
backend/src/
  trade-docs/
    trade-doc-router.ts       # 路由
    trade-doc-service.ts      # 业务逻辑
    trade-doc-store.ts        # MySQL 持久化
    pdf-generator.ts          # Puppeteer PDF 管线
    trade-doc-i18n.ts         # i18n 字典加载
    templates/
      invoice.html            # PI/CI/Quotation 模板
      packing-list.html       # 装箱单模板
      contract.html           # 销售合同模板
      coo.html                # 原产地证模板
      shipping-advice.html    # 装运通知模板
  uploads/trade-docs/         # PDF 文件存储

frontend/src/
  trade-docs/
    trade-doc-app.ts          # 单证管理主组件
    trade-doc-editor.ts       # 编辑器组件
    trade-doc-list.ts         # 列表页组件

i18n/
  trade-doc-labels.json       # 多语言标签
```

---

## 10. 技术约束与风险

| 约束/风险 | 对策 |
|---|---|
| Puppeteer 内存占用 | 单实例复用 browser，超时 30s 自动 kill |
| 阿拉伯语字体缺失 | Docker 镜像预装 `fonts-noto-naskh-arabic` |
| WhatsApp 发送频率限制 | 队列化，间隔 ≥3s，失败重试 3 次 |
| PDF 文件存储 | 开发期本地；生产期对象存储 |
| 并发编号冲突 | MySQL `FOR UPDATE` 或 Redis 原子递增 |
| 7 种模板维护成本 | PI/CI/Quotation 共用基础模板，减少冗余 |

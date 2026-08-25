# GoodJob CRM 酷炫功能开发方案

> 5 个功能的详细实施方案，逐一开发、审核、自测

---

## 功能 1: 暗色模式 — 全站一键切换

### 目标
用户点击导航栏按钮即可在亮色/暗色之间切换，选择持久化到 localStorage。

### 设计审核要点
- 暗色不是简单反色：需要降低对比度但保持可读性
- 品牌色在暗色背景下需提亮（增加亮度、降低饱和度）
- 阴影在暗色模式需改为发光效果（dark glow）
- 所有硬编码 `#fff`/`#f8faff` 背景色需改为变量引用
- nav 区域已经是暗色（`--nav: #141925`），需适配

### CSS 变量映射

| 变量 | 亮色 (当前) | 暗色 (新增) |
|------|------------|------------|
| --bg | #f4f6fb | #0d1017 |
| --surface | #ffffff | #181c28 |
| --surface-2 | #f7f9fd | #141824 |
| --surface-3 | #eef2f8 | #1e2435 |
| --ink | #131a2a | #e8eaf0 |
| --text | #2a3445 | #b8c0d0 |
| --muted | #6b7689 | #6a7284 |
| --line | #e2e7f0 | #2a3142 |
| --line-soft | #eef1f7 | #1e2435 |
| --nav | #141925 | #0a0d14 |
| --nav-soft | #1f2533 | #121620 |
| --brand-tint | #eaf0ff | #1a2240 |
| --green-tint | #e7f6ee | #0d2820 |
| --amber-tint | #fbf1dc | #2a2110 |
| --rose-tint | #fdeceb | #2a1015 |
| --shadow-xs/sm/soft | rgba(20,30,55,*) | rgba(0,0,0,*) |

### 实施步骤

#### Step 1: CSS — 暗色变量块
在 `index.html` 的 `:root {}` 块之后，添加 `[data-color-scheme="dark"]` 块，覆盖所有颜色变量。

#### Step 2: CSS — 硬编码颜色修复
搜索 `index.html` 中所有 `background: #fff` / `background:#f8faff` / `background: white` 等硬编码色值，替换为 `var(--surface)` 等变量引用。重点区域：
- `.deal-detail-grid .info` → `background: var(--surface-2)`
- `.customer-filter-row input` → `background: var(--surface)`

#### Step 3: CSS — 过渡动画
给 `body` 和关键元素添加 `transition: background-color .3s ease, color .3s ease`，实现平滑切换。

#### Step 4: HTML — 切换按钮
在 `topbar` 的 `top-actions` 区域，通知铃和用户菜单之间，添加切换按钮：
```html
<button class="btn icon-only" id="themeToggleButton" title="切换深色模式">
  <!-- 太阳/月亮 SVG 图标 -->
</button>
```

#### Step 5: JS — 切换逻辑
在 `prototype-api.ts` 中：
- `initThemeToggle()` 函数：读取 localStorage `gj_color_scheme`，应用 `data-color-scheme` 属性
- 按钮点击事件：切换 dark/light，更新图标，保存到 localStorage
- 在 `installEvents()` 中调用

### 自测标准
- [ ] 亮色模式不变（无回归）
- [ ] 暗色模式：文字可读、对比度 ≥ 4.5:1
- [ ] 切换动画流畅（300ms）
- [ ] 刷新页面后保持上次选择
- [ ] 导航栏、侧边栏、主区域、弹窗、抽屉全部正确适配

---

## 功能 2: 商机赢率 AI 预测仪表盘

### 目标
在商机详情抽屉顶部，显示一个 SVG 弧形仪表盘，展示 AI 预测的赢率百分比，配合因子分解条形图和 AI 建议。

### 设计审核要点
- 仪表盘弧形：270° 弧，指针动画从 0 转到预测值
- 颜色渐变：红(0-30%) → 琥珀(31-60%) → 绿(61-100%)
- 因子条形图：每个因子水平条，宽度代表影响权重
- 整体嵌入抽屉，不能撑爆宽度
- AI 建议文案区域有 AI 图标标识

### 后端 API
新增 `GET /api/deals/:id/win-probability`：
- 查询该客户历史成交/丢单记录
- 查询该商机事件历史
- 计算因子权重：
  1. 阶段进展度 (已报价→样品→谈判→成交 = 25%→50%→75%→100%)
  2. 客户历史成交率 (该客户过去成交/总商机)
  3. 跟进频率 (最近7天跟进次数)
  4. 金额合理性 (对比同类客户平均成交额)
  5. 响应速度 (从初次联系到当前的天数)
- 输出：赢率%、5 个因子分值、AI 建议文案

### 前端 UI
在 `renderDealDrawer()` 中，在 `deal-detail-grid` 之后、`deal-detail-actions` 之前，插入：
```html
<section class="deal-win-gauge">
  <div class="gauge-wrap">
    <svg viewBox="0 0 200 120">...</svg>  <!-- 弧形仪表盘 -->
    <div class="gauge-center">
      <b class="gauge-value">68%</b>
      <span>AI 预测赢率</span>
    </div>
  </div>
  <div class="gauge-factors">
    <!-- 5 个因子水平条 -->
  </div>
  <div class="gauge-advice">
    <svg>AI 图标</svg>
    <p>建议：客户历史成交率较高，建议在报价后48小时内安排样品...</p>
  </div>
</section>
```

### 自测标准
- [ ] 仪表盘指针动画流畅
- [ ] 颜色随赢率区间正确变化
- [ ] 因子条形图对齐、数值正确
- [ ] AI 建议文案与因子关联
- [ ] 暗色模式下仪表盘正确显示

---

## 功能 3: 业绩游戏化 — 排行榜 + 徽章

### 目标
Dashboard 顶部新增周排行榜卡片 + 个人成就徽章墙。

### 设计审核要点
- 排行榜：金银铜配色，前 3 名特殊样式（奖牌图标）
- 徽章：圆形/六边形图标，未解锁灰色+锁图标，已解锁彩色+发光
- 整体风格：游戏化但不幼稚，保持商务感
- 排行榜数据本周范围（周一至今）
- 徽章墙在排行榜右侧或下方

### 后端 API
新增 `GET /api/gamification/leaderboard?period=week`：
- 查询本周成交商机（stage=成交），按业务员聚合
- 返回：排名、用户名、头像、成交额、新客数、转化率

新增 `GET /api/gamification/badges`：
- 检查当前用户所有徽章解锁状态
- 返回：徽章ID、名称、描述、图标、是否解锁、解锁时间

徽章清单：
1. 首单达成 — 首次成交商机
2. 连续跟进 — 连续 7 天有跟进记录
3. 月度冠军 — 当月成交额第一
4. 客户开拓者 — 本月新增 5+ 客户
5. 样品达人 — 本月发出 3+ 样品
6. 谈判专家 — 本月进入谈判阶段 3+ 商机
7. 百万业绩 — 累计成交额超 $100,000
8. 全勤战士 — 连续 30 天有登录

### 前端 UI
在 Dashboard 的 `command-center` 之前，添加：
```html
<div class="gamification-row">
  <section class="panel leaderboard-panel">
    <div class="section-head"><h2>本周排行榜</h2><span>实时</span></div>
    <div class="leaderboard-list">
      <!-- 每行：排名 | 头像 | 姓名 | 成交额 | 趋势 -->
    </div>
  </section>
  <section class="panel badges-panel">
    <div class="section-head"><h2>我的成就</h2><span>已解锁 N/M</span></div>
    <div class="badges-grid">
      <!-- 徽章卡片 -->
    </div>
  </section>
</div>
```

### 自测标准
- [ ] 排行榜前 3 名有奖牌样式
- [ ] 徽章解锁/未解锁视觉差异明显
- [ ] 数据与实际商机/客户一致
- [ ] 暗色模式下正确显示
- [ ] 响应式：移动端堆叠

---

## 功能 4: 客户旅程动画时间线

### 目标
客户详情抽屉顶部，用水平动画时间线替代静态活动列表。每个触点一个节点，从左到右依次亮起，悬停显示详情，阶段渐变色。

### 设计审核要点
- 水平时间线：节点从左到右排列，连线渐变色
- 节点类型不同图标不同：WhatsApp/邮件/电话/报价/样品/成交
- 动画：进入抽屉时节点逐个亮起（200ms 间隔）
- 悬停：弹出 tooltip 显示详情
- 当前阶段节点有脉冲动画
- 连接线：已完成段实色，未完成段虚线
- 暗色模式下时间线发光效果

### 前端实现
在 `renderCustomerDrawer()` 中，在 `drawer-head` 之后、`customer-time-card` 之前，插入：
```html
<section class="journey-timeline">
  <div class="journey-track">
    <div class="journey-line"></div>
    <!-- 每个活动一个节点 -->
    <div class="journey-node" data-type="whatsapp" style="--delay: 0ms">
      <div class="journey-dot"><!-- 图标 --></div>
      <div class="journey-label">WhatsApp</div>
      <div class="journey-tooltip"><!-- 详情 --></div>
    </div>
  </div>
</section>
```

CSS 动画：
- `@keyframes journeyLight` — 节点从灰色变彩色
- `@keyframes journeyPulse` — 当前节点脉冲
- `--delay` 变量控制逐个亮起

### 自测标准
- [ ] 节点逐个亮起动画流畅
- [ ] 不同活动类型有不同图标
- [ ] 悬停 tooltip 正确显示详情
- [ ] 当前阶段节点有脉冲
- [ ] 暗色模式下发光效果
- [ ] 无活动时显示空状态

---

## 功能 5: AI 语音会议纪要

### 目标
客户详情抽屉中添加"录制会议"按钮，用浏览器 Web Speech API 录音转文字 → AI 总结 → 自动提取行动项 → 关联客户 → 自动建待办。

### 设计审核要点
- 录制按钮：红色圆点动画（呼吸灯效果）
- 录制中：波形动画（CSS bars）
- AI 处理中：旋转加载动画
- 纪要卡片：时间、时长、摘要、行动项列表
- 行动项可勾选 → 自动创建待办
- 整体不破坏客户抽屉布局

### 前端实现
1. 在 `renderCustomerDrawer()` 的 `inline-actions` 中添加按钮：
```html
<button class="btn" data-customer-record>录制会议</button>
```

2. 点击后弹出模态框：
```html
<div class="meeting-recorder">
  <div class="recorder-status">
    <div class="recorder-pulse"></div>
    <span>录制中...</span>
    <b class="recorder-timer">00:00</b>
  </div>
  <div class="recorder-wave"><!-- 波形动画 bars --></div>
  <div class="recorder-transcript"><!-- 实时转写文字 --></div>
  <button class="btn danger" id="stopRecordingBtn">停止录制</button>
</div>
```

3. 停止后调用 AI：
- POST `/api/ai/meeting-summary` 传转写文字
- 后端调用 AI Agent 总结 + 提取行动项
- 返回：摘要、行动项列表

4. 展示纪要卡片，行动项可勾选创建待办

### 技术细节
- Web Speech API: `webkitSpeechRecognition` (Chrome/Safari)
- 降级：不支持时显示"请使用 Chrome 浏览器"
- 语言：`lang = 'zh-CN'`，支持中英文
- 连续模式 + 中间结果

### 自测标准
- [ ] 录制按钮呼吸灯动画
- [ ] 实时转写显示
- [ ] AI 总结准确
- [ ] 行动项可勾选创建待办
- [ ] 纪要卡片保存到客户活动记录
- [ ] 暗色模式下正确显示
- [ ] 不支持浏览器时友好降级

---

## 实施顺序

1. ✅ 暗色模式（基础设施，其他功能依赖）
2. ✅ 商机赢率预测仪表盘
3. ✅ 业绩游戏化
4. ✅ 客户旅程动画时间线
5. ✅ AI 语音会议纪要

每个功能：方案审核 → 开发 → 自测 → 进入下一个

---

## 最终验证 (2026-08-01)

- 后端 TypeScript 编译：✅ 0 错误
- 前端 TypeScript 编译：✅ 0 错误
- 后端服务 (localhost:4188)：✅ 运行中
- 前端服务 (localhost:5188)：✅ 运行中
- launchd 服务 (com.goodjob.crm.personal)：✅ 活跃

### API 端点验证
| 端点 | 方法 | 行号 | 状态 |
|------|------|------|------|
| /api/deals/:id/win-probability | GET | 5217 | ✅ 已注册 |
| /api/dashboard/leaderboard | GET | 13849 | ✅ 已注册 |
| /api/dashboard/badges | GET | 13880 | ✅ 已注册 |
| /api/customers/:id/meeting-notes | POST | 3278 | ✅ 已注册 |

### 前端函数验证
| 函数 | 行号 | 功能 |
|------|------|------|
| initThemeToggle() | 24241 | 暗色模式切换 |
| loadDealWinProbability() | 10139 | 赢率仪表盘加载 |
| loadLeaderboard() | 5702 | 排行榜加载 |
| loadBadges() | 5729 | 徽章墙加载 |
| renderCustomerJourney() | 8891 | 客户旅程时间线 |
| openMeetingRecorder() | 8954 | 会议录制启动 |
| summarizeMeeting() | 9032 | AI会议纪要 |

**全部 5 个功能已实现、编译通过、服务运行正常。**

---

## 6. 排行榜独立页面（2026-08-01 新增）

### 需求
- 将"本周排行"+"成就徽章"从工作台（dashboard）移出，做成独立页面。
- 丰富内容：周期切换、多维度排序、领奖台、完整榜单、个人战绩卡、徽章墙。

### 设计
**后端** (`backend/src/server.ts` 的 `/api/dashboard/leaderboard`):
- 新增 `?period=week|month|quarter|year` 查询参数（滚动窗口：7/30/90/365 天）。
- 增加 `prevWonAmount`（上一周期同窗成交额）用于趋势箭头。
- 增加 `score` 综合战力值：`wonAmount/1000 + wonCount*200 + newCustomers*500 + followUps*20`。
- 返回字段保持 `entries[]`：userId,userName,avatar,wonAmount,wonCount,newCustomers,conversionRate,followUps,prevWonAmount,score,rank。

**前端**:
1. 侧边栏二级导航新增 `data-view="leaderboard"` 入口「业绩榜」。
2. `viewLabels` 增加 `leaderboard: "业绩榜"`。
3. `index.html` 新增 `<div class="view" id="leaderboard">` 骨架。
4. `activateNavView` 增加 `if (view === "leaderboard") void renderLeaderboardPage();`。
5. 实现 `renderLeaderboardPage()`：
   - 周期 Tab（近7天/本月/本季/本年）+ 维度 Tab（成交额/新客数/跟进数/综合）。
   - 领奖台（Top3 冠亚季军卡）。
   - 完整榜单表格（名次、头像+姓名、数值、趋势箭头、进度条）。
   - 个人战绩卡（我的排名、战力值、距上一名差距、已得徽章数）。
   - 徽章墙（复用 `/api/dashboard/badges`）。
6. 工作台移除：`.gamification-row` 区块 + `renderDashboard` 中 `void loadLeaderboard()`/`void loadBadges()` 调用。

### 视觉自检（高级美工视角）
- 领奖台用渐变金/银/铜色 + 轻微上浮 hover；Top1 略高于 2/3 名形成阶梯。
- 榜单表格斑马纹 + 当前用户行高亮（brand-tint）。
- 进度条用品牌色，趋势箭头红涨绿跌（A股习惯：涨红跌绿 → 此处增长用红色↑、下降用绿色↓，符合中文习惯）。
- 个人战绩卡用品牌渐变描边，徽章墙网格 4 列、已达成彩色+未达成灰度。
- 响应式：窄屏单栏。

### 自测
- tsc 编译 0 错误；重启服务；导航到业绩榜确认渲染；周期/维度切换数据正确；工作台无残留。

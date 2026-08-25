const icon = (name) => `<i data-lucide="${name}"></i>`;

const viewMeta = {
  dashboard: {
    breadcrumb: "工作台",
    title: "经营工作台",
    subtitle: "聚焦今天最值得推进的客户与商机。",
    actions: [
      ["晨会视图", "presentation", ""],
      ["新增待办", "plus", "primary"]
    ]
  },
  "lead-finder": {
    breadcrumb: "自动获客",
    title: "自动获客",
    subtitle: "建立目标，组合数据源，并持续收集可验证企业。",
    actions: [
      ["定期计划", "calendar-clock", ""],
      ["开始搜索", "play", "primary"]
    ]
  },
  "prospect-list": {
    breadcrumb: "搜客清单",
    title: "搜客清单",
    subtitle: "审核搜索结果，将合适企业转入线索池。",
    actions: [
      ["导出", "download", ""],
      ["导入线索", "arrow-right", "primary"]
    ]
  },
  leads: {
    breadcrumb: "线索",
    title: "线索管理",
    subtitle: "从待确认线索中识别真实采购机会。",
    actions: [
      ["批量分配", "user-round-plus", ""],
      ["新建线索", "plus", "primary"]
    ]
  },
  customers: {
    breadcrumb: "客户",
    title: "客户",
    subtitle: "集中管理客户关系、联系方式、商机与跟进记录。",
    actions: [
      ["客户地图", "map", ""],
      ["新建客户", "plus", "primary"]
    ]
  },
  pipeline: {
    breadcrumb: "商机",
    title: "商机管道",
    subtitle: "围绕下一步动作推进每一笔真实机会。",
    actions: [
      ["管道分析", "chart-no-axes-combined", ""],
      ["新建商机", "plus", "primary"]
    ]
  },
  "customer-pool": {
    breadcrumb: "客户公池",
    title: "客户公池",
    subtitle: "释放暂不跟进的客户，让团队重新认领。",
    actions: [
      ["公池规则", "sliders-horizontal", ""],
      ["批量认领", "user-check", "primary"]
    ]
  },
  communication: {
    breadcrumb: "Communication",
    title: "Communication",
    subtitle: "通过已绑定渠道持续跟进客户对话。",
    actions: [
      ["账号管理", "smartphone", ""],
      ["新建会话", "message-square-plus", "primary"]
    ]
  },
  agent: {
    breadcrumb: "小K Agent",
    title: "小K Agent",
    subtitle: "用对话完成查询、创建与跨模块业务动作。",
    actions: [
      ["任务记录", "history", ""],
      ["新对话", "square-pen", "primary"]
    ]
  },
  documents: {
    breadcrumb: "单据平台",
    title: "单据平台",
    subtitle: "从客户和商机数据快速生成标准外贸单据。",
    actions: [
      ["模板管理", "layout-template", ""],
      ["新建单据", "file-plus-2", "primary"]
    ]
  },
  reports: {
    breadcrumb: "经营报表",
    title: "经营报表",
    subtitle: "查看获客、客户、商机与团队的经营结果。",
    actions: [
      ["导出报告", "download", ""],
      ["生成汇报", "presentation", "primary"]
    ]
  },
  training: {
    breadcrumb: "销售训练",
    title: "销售能力训练",
    subtitle: "通过持续训练沉淀团队中的高质量销售方法。",
    actions: [
      ["训练记录", "history", ""],
      ["创建训练", "plus", "primary"]
    ]
  },
  settings: {
    breadcrumb: "系统设置",
    title: "系统设置",
    subtitle: "配置组织、权限、数据策略与系统能力。",
    actions: [["保存更改", "save", "primary"]]
  }
};

const customers = [
  ["Kanto Retail", "日本", "A", "Nordic Tools 年度采购", "$36,000", "今天 14:30", "进行中"],
  ["Alpine Technik GmbH", "德国", "A", "工业传感器项目", "$52,400", "明天 09:00", "待报价"],
  ["Solis Energia", "西班牙", "B", "逆变器备件", "$18,700", "7 月 27 日", "已联系"],
  ["Meridian Supply", "美国", "B", "仓储设备配套", "$27,800", "7 月 29 日", "跟进中"],
  ["Northbridge Controls", "英国", "C", "控制模块替换", "$9,600", "8 月 2 日", "待确认"]
];

function actionButtons(actions = []) {
  return actions.map(([label, iconName, className]) => `
    <button class="button ${className}" type="button" data-action="${label}">${icon(iconName)}<span>${label}</span></button>
  `).join("");
}

function metricStrip(items) {
  return `<div class="metric-strip">${items.map(([label, value, detail, cls = ""]) => `
    <div class="metric"><span>${label}</span><b class="${cls}">${value}</b><small>${detail}</small></div>
  `).join("")}</div>`;
}

function customerRows(rows = customers) {
  return rows.map((row, index) => `
    <tr>
      <td><div class="table-company"><span class="company-logo">${row[0].split(" ").map(word => word[0]).slice(0, 2).join("")}</span><span><strong>${row[0]}</strong><small>${index % 2 ? "分销商" : "终端采购"}</small></span></div></td>
      <td>${row[1]}</td>
      <td><span class="grade ${row[2].toLowerCase()}">${row[2]}</span></td>
      <td>${row[3]}</td>
      <td><strong>${row[4]}</strong></td>
      <td>${row[5]}</td>
      <td><span class="status ${row[6] === "进行中" ? "mint" : row[6] === "待报价" ? "amber" : ""}">${row[6]}</span></td>
      <td><button class="button ghost small" type="button" data-action="查看客户">查看</button></td>
    </tr>
  `).join("");
}

function dashboardView() {
  return `
    <section class="executive-hero">
      <div class="executive-copy">
        <span class="executive-kicker">今日经营焦点</span>
        <h2>先拿下 Kanto Retail，再处理交期风险。</h2>
        <p>两笔重点商机占本月加权金额的 46%。报价有效期与交期承诺将在 48 小时内到期。</p>
        <div class="executive-actions">
          <button class="button hero-primary" type="button" data-action="打开重点商机">${icon("arrow-up-right")}打开重点商机</button>
          <button class="button hero-secondary" type="button" data-view="agent">${icon("sparkles")}交给小K</button>
        </div>
      </div>
      <div class="signal-board" aria-label="本月成交信号">
        <div class="signal-head"><span>本月成交信号</span><b>+18.6%</b></div>
        <strong>$112k</strong>
        <small>加权商机金额</small>
        <div class="signal-bars" aria-hidden="true">
          <i style="--h:31%"></i><i style="--h:46%"></i><i style="--h:38%"></i><i style="--h:58%"></i><i style="--h:52%"></i><i style="--h:74%"></i><i style="--h:68%"></i><i style="--h:88%"></i><i style="--h:82%"></i><i style="--h:100%"></i>
        </div>
        <div class="signal-axis"><span>7 月 1 日</span><span>今天</span></div>
      </div>
      <div class="hero-stats">
        <div><span>今日待办</span><b>12</b><small>3 项中午前处理</small></div>
        <div><span>高风险商机</span><b class="risk">$54k</b><small>2 笔超过停留阈值</small></div>
        <div><span>预计成交</span><b class="positive">$112k</b><small>本月加权金额</small></div>
        <div><span>新增线索</span><b>28</b><small>11 条来自超级搜索</small></div>
      </div>
    </section>
    <div class="layout-2">
      <div>
        <section class="panel priority-panel">
          <div class="panel-head"><h2>${icon("list-checks")}下一步动作</h2><span>按业务影响排序</span></div>
          <div class="action-list">
            <div class="action-row"><i></i><div><b>Kanto Retail 年度采购报价确认</b><span>客户等待最终价格和 45 天交期确认</span></div><time>14:30</time></div>
            <div class="action-row"><i class="amber"></i><div><b>Nordic Tools 延期风险处理</b><span>同步替代运输方案并更新 PI</span></div><time>16:00</time></div>
            <div class="action-row"><i class="mint"></i><div><b>Alpine Technik 样品反馈</b><span>样品签收 3 天，等待测试结论</span></div><time>明天</time></div>
            <div class="action-row"><i class="slate"></i><div><b>Meridian Supply 采购需求复核</b><span>确认本季度仓储设备采购范围</span></div><time>周一</time></div>
          </div>
        </section>
      </div>
      <div>
        <section class="panel health-panel">
          <div class="panel-head"><h2>${icon("chart-no-axes-column-increasing")}商机健康度</h2><span>5 个阶段</span></div>
          <div class="panel-body pipeline-mini">
            <div class="pipeline-mini-row"><span>询盘</span><div class="line-track"><i style="--value:78%"></i></div><b>$96k</b></div>
            <div class="pipeline-mini-row"><span>已联系</span><div class="line-track"><i style="--value:62%"></i></div><b>$74k</b></div>
            <div class="pipeline-mini-row"><span>已报价</span><div class="line-track"><i style="--value:48%"></i></div><b>$54k</b></div>
            <div class="pipeline-mini-row"><span>谈判</span><div class="line-track"><i style="--value:31%"></i></div><b>$36k</b></div>
          </div>
        </section>
        <section class="panel acquisition-panel" style="margin-top:16px">
          <div class="panel-head"><h2>${icon("activity")}获客流入</h2><span>最近 24 小时</span></div>
          <div class="action-list">
            <div class="action-row"><i></i><div><b>AI 深度发现</b><span>18 家企业，7 家可联系</span></div><time>42%</time></div>
            <div class="action-row"><i class="mint"></i><div><b>实时网页搜索</b><span>22 家企业，11 家可联系</span></div><time>50%</time></div>
            <div class="action-row"><i class="amber"></i><div><b>地图企业搜索</b><span>9 家企业，4 家可联系</span></div><time>44%</time></div>
          </div>
        </section>
      </div>
    </div>`;
}

function leadFinderView() {
  return `
    ${metricStrip([
      ["进行中任务", "3", "1 个超级搜索任务"],
      ["本轮原始企业", "186", "来自 6 个数据源"],
      ["可联系", "42", "验证率 22.6%", "positive"],
      ["已清洗", "74", "重复、地区与主体过滤"]
    ])}
    <div class="layout-3">
      <section class="panel">
        <div class="panel-head"><h2>${icon("target")}获客目标</h2><span>超级搜索</span></div>
        <div class="panel-body search-form">
          <div class="form-grid">
            <div class="field"><label>产品关键词</label><input class="input" value="industrial sensor"></div>
            <div class="field"><label>国家或地区</label><select class="select"><option>德国</option><option>欧洲</option></select></div>
            <div class="field wide"><label>补充获客目标</label><textarea class="textarea">寻找德国工业自动化设备分销商，优先有传感器和控制器产品线的企业。</textarea></div>
          </div>
          <div class="field"><label>数据来源</label>
            <div class="source-list">
              <label class="source-option"><input type="checkbox" checked><span><b>AI 深度发现</b><small>多轮检索和企业归纳</small></span><em>可用</em></label>
              <label class="source-option"><input type="checkbox" checked><span><b>实时网页搜索</b><small>Serper 与公开网页</small></span><em>可用</em></label>
              <label class="source-option"><input type="checkbox"><span><b>地图企业搜索</b><small>Google Places 企业地点</small></span><em>可用</em></label>
            </div>
          </div>
          <button class="button primary" type="button" data-action="搜索任务已启动">${icon("play")}开始超级搜索</button>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>${icon("radio-tower")}实时执行</h2><div class="segmented"><button class="active">摘要</button><button>狂跑</button></div></div>
        <div class="stream">
          <div class="stream-line success"><time>17:21:04</time><b>目标解析</b><span>已生成 8 组搜索路径，国家条件作为优先项</span></div>
          <div class="stream-line"><time>17:21:05</time><b>AI 搜索</b><span>请求模型生成首轮候选企业与检索依据</span></div>
          <div class="stream-line success"><time>17:21:18</time><b>AI 搜索</b><span>返回 32 家候选，进入域名与主体核验</span></div>
          <div class="stream-line"><time>17:21:19</time><b>网页搜索</b><span>正在执行查询 3/12: distributor industrial sensor Germany</span></div>
          <div class="stream-line warning"><time>17:21:26</time><b>清洗</b><span>移除 6 条目录页和 3 条非企业主体</span></div>
          <div class="stream-line success"><time>17:21:31</time><b>联系方式</b><span>已验证 11 个企业邮箱与 4 个 WhatsApp</span></div>
          <div class="stream-line"><time>17:21:33</time><b>网页搜索</b><span>正在执行查询 4/12，当前已收集 48 家企业</span></div>
          <div class="stream-line"><time>17:21:36</time><b>去重</b><span>按域名、公司名称和注册地址进行实体合并</span></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>${icon("database-zap")}来源矩阵</h2><span>186 条原始结果</span></div>
        <div class="source-progress">
          <div class="source-progress-row"><div><b>AI 深度发现</b><small>32 返回，18 个可验证</small></div><strong>32</strong><span class="status mint">成功</span></div>
          <div class="source-progress-row"><div><b>实时网页搜索</b><small>查询 4/12，持续执行</small></div><strong>48</strong><span class="status amber">运行中</span></div>
          <div class="source-progress-row"><div><b>地图企业搜索</b><small>本任务未启用</small></div><strong>0</strong><span class="status">未启用</span></div>
          <div class="source-progress-row"><div><b>企业目录</b><small>74 返回，39 条重复</small></div><strong>74</strong><span class="status mint">完成</span></div>
          <div class="source-progress-row"><div><b>公开 API</b><small>2 个端点均已返回</small></div><strong>32</strong><span class="status mint">完成</span></div>
        </div>
      </section>
    </div>`;
}

function customerTableView(kind = "customers") {
  const isProspect = kind === "prospect-list";
  const isLead = kind === "leads";
  return `
    ${metricStrip(isProspect ? [
      ["候选企业", "186", "本轮共 6 个来源"], ["待审核", "58", "包含未完成清洗结果"], ["可联系", "42", "已验证联系方式", "positive"], ["已入线索", "28", "同步成功率 100%"]
    ] : isLead ? [
      ["线索总数", "328", "本月新增 76"], ["待分配", "24", "需要团队认领"], ["高意向", "38", "近 7 天有有效动作", "positive"], ["转客户率", "18.4%", "较上月提升 2.7%"]
    ] : [
      ["客户总数", "1,286", "来自 32 个国家"], ["A级客户", "86", "7 天内需跟进 18 家"], ["成交客户", "214", "历史成交金额 $3.8m", "positive"], ["风险客户", "27", "连续 30 天无有效动作", "risk"]
    ])}
    <section class="panel">
      <div class="table-tools">
        <input class="input" placeholder="搜索公司、联系人或国家">
        <div class="segmented"><button class="active">全部</button><button>A 级</button><button>待跟进</button><button>已成交</button></div>
        <button class="button small" type="button" data-action="筛选器已打开">${icon("sliders-horizontal")}筛选</button>
      </div>
      <div style="overflow:auto">
        <table class="data-table" style="min-width:980px">
          <thead><tr><th style="width:23%">${isProspect ? "候选企业" : isLead ? "线索" : "客户"}</th><th style="width:8%">国家</th><th style="width:7%">分级</th><th style="width:20%">当前需求</th><th style="width:11%">商机金额</th><th style="width:12%">下次跟进</th><th style="width:10%">状态</th><th style="width:9%">操作</th></tr></thead>
          <tbody>${customerRows()}</tbody>
        </table>
      </div>
    </section>`;
}

function pipelineView() {
  const cards = {
    "询盘": [["Meridian Supply", "仓储设备配套", "$27.8k", "35%"], ["Solis Energia", "逆变器备件", "$18.7k", "25%"]],
    "已联系": [["Northbridge Controls", "控制模块替换", "$9.6k", "45%"]],
    "已报价": [["Alpine Technik", "工业传感器项目", "$52.4k", "68%"], ["Boreal Systems", "年度备件框架", "$31.2k", "60%"]],
    "谈判": [["Kanto Retail", "Nordic Tools 年度采购", "$36k", "82%"]],
    "赢单": [["Helix Automation", "检测设备升级", "$44.8k", "100%"]]
  };
  return `
    ${metricStrip([["管道金额", "$286k", "9 笔有效商机"], ["加权金额", "$146k", "预计本月成交 $82k", "positive"], ["平均周期", "23 天", "较上月缩短 4 天"], ["风险金额", "$54k", "2 笔超过停留阈值", "risk"]])}
    <div class="kanban">${Object.entries(cards).map(([stage, deals]) => `
      <section class="kanban-column">
        <div class="kanban-head"><b>${stage}</b><span>${deals.length} 笔</span></div>
        ${deals.map(([company, title, amount, probability]) => `
          <article class="deal-card" data-action="打开商机">
            <h3>${title}</h3><p>${company}</p>
            <div class="deal-meta"><strong>${amount}</strong><span>7 月 29 日</span></div>
            <div class="probability"><i style="--p:${probability}"></i><span>${probability}</span></div>
          </article>`).join("")}
      </section>`).join("")}</div>`;
}

function poolView() {
  const poolRows = [
    ["Orion Components", "美国", "B", "电子元件分销", "$0", "可立即认领", "公池"],
    ["Ventura Process", "墨西哥", "C", "流程设备集成", "$0", "剩余 2 天", "公池"],
    ["Rhein Industrial", "德国", "B", "工业备件采购", "$12,000", "剩余 4 天", "有商机"]
  ];
  return `
    ${metricStrip([["公池客户", "94", "近 30 天新增 21"], ["今日可认领", "18", "每人上限 5 家"], ["重新激活", "12", "本月回收客户", "positive"], ["即将释放", "7", "24 小时内进入公池"]])}
    <section class="panel">
      <div class="table-tools"><input class="input" placeholder="搜索公池客户"><div class="segmented"><button class="active">全部</button><button>可认领</button><button>有商机</button></div></div>
      <table class="data-table"><thead><tr><th>客户</th><th>国家</th><th>分级</th><th>业务类型</th><th>历史商机</th><th>认领状态</th><th>状态</th><th>操作</th></tr></thead><tbody>${customerRows(poolRows)}</tbody></table>
    </section>`;
}

function communicationView() {
  const conversations = [
    ["KT", "Kanto Retail", "Could you confirm the lead time?", "10:42"],
    ["AT", "Alpine Technik", "The samples arrived this morning.", "09:18"],
    ["MS", "Meridian Supply", "Thank you for the updated quotation.", "昨天"],
    ["SE", "Solis Energia", "Please send the certificate list.", "周三"]
  ];
  return `<div class="chat-layout">
    <aside class="chat-list">
      <div class="chat-search"><input class="input" placeholder="搜索会话"></div>
      <div class="conversation-list">${conversations.map((item, index) => `
        <button class="conversation ${index === 0 ? "active" : ""}" type="button">
          <span class="conversation-avatar">${item[0]}</span><span><b>${item[1]}</b><span>${item[2]}</span></span><time>${item[3]}</time>
        </button>`).join("")}</div>
    </aside>
    <section class="chat-main">
      <header class="chat-head"><div><h2>Kanto Retail</h2><span>WhatsApp · +81 90 4821 6350</span></div><div class="page-actions"><button class="icon-button" title="客户全景">${icon("panel-right-open")}</button><button class="icon-button" title="更多">${icon("ellipsis")}</button></div></header>
      <div class="message-stage" id="messageStage">
        <div class="message">Hi Alex, we have reviewed the quotation. Could you confirm whether the 45-day lead time includes shipping?<time>10:38</time></div>
        <div class="message mine">Yes. The current estimate includes production and sea freight to Yokohama. I will send the detailed schedule today.<time>10:40</time></div>
        <div class="message">Great. Please also include the payment schedule in the updated PI.<time>10:42</time></div>
      </div>
      <div class="chat-compose"><button class="icon-button" title="附件">${icon("paperclip")}</button><button class="icon-button" title="图片">${icon("image")}</button><input class="input" id="chatInput" placeholder="输入消息"><button class="button primary" type="button" id="sendChat">${icon("send")}发送</button></div>
    </section>
    <aside class="contact-pane">
      <div class="contact-cover"><span class="conversation-avatar">KT</span><h3>Kanto Retail</h3><p>日本 · A 级客户</p></div>
      <div class="contact-facts"><div><span>联系人</span><b>Haruto Sato</b></div><div><span>当前商机</span><b>Nordic Tools 年度采购</b></div><div><span>预计金额</span><b>$36,000</b></div><div><span>下次动作</span><b>更新 PI 与付款计划</b></div></div>
    </aside>
  </div>`;
}

function agentView() {
  return `<div class="agent-layout">
    <section class="agent-chat">
      <header class="agent-head"><strong>客户推进助手</strong><span>使用组织知识与 CRM 工具</span></header>
      <div class="agent-messages" id="agentMessages">
        <div class="agent-message user"><b>你</b><p>帮我为 Kanto Retail 的年度采购商机生成 PI，并准备下载。</p></div>
        <div class="agent-message"><b>小K</b><p>我已定位到 Kanto Retail 的“Nordic Tools 年度采购”商机。正在读取报价、产品明细和客户开票信息，随后会创建 PI 并导出 PDF。</p></div>
      </div>
      <div class="agent-compose"><div class="agent-compose-box"><textarea id="agentInput" placeholder="告诉小K你希望完成什么"></textarea><button class="button primary" id="agentSend" type="button">${icon("arrow-up")}发送</button></div></div>
    </section>
    <aside class="agent-run">
      <header class="run-head"><strong>执行过程</strong><span class="status amber">进行中</span></header>
      <div class="run-progress"><div><span>目标完成度</span><b>68%</b></div><div class="line-track"><i></i></div></div>
      <div class="step-list">
        <div class="run-step"><span class="step-icon">${icon("circle-check")}</span><div><b>理解目标</b><span>识别客户、商机、单据类型与下载要求</span></div><time>完成</time></div>
        <div class="run-step"><span class="step-icon">${icon("circle-check")}</span><div><b>读取商机</b><span>找到唯一匹配商机，金额 USD 36,000</span></div><time>完成</time></div>
        <div class="run-step"><span class="step-icon">${icon("circle-check")}</span><div><b>补全单据信息</b><span>读取报价明细、客户地址和付款条款</span></div><time>完成</time></div>
        <div class="run-step"><span class="step-icon">${icon("loader-circle")}</span><div><b>创建 PI</b><span>正在提交单据草稿并进行字段校验</span></div><time>8 秒</time></div>
        <div class="run-step"><span class="step-icon">${icon("file-down")}</span><div><b>导出 PDF</b><span>等待单据创建结果</span></div><time>等待</time></div>
      </div>
    </aside>
  </div>`;
}

function documentsView() {
  return `
    ${metricStrip([["本月单据", "42", "较上月增加 8 份"], ["待确认", "6", "需要业务员补全"], ["已发送", "31", "客户打开率 77%", "positive"], ["异常", "1", "税号字段缺失", "risk"]])}
    <div class="layout-2">
      <section class="panel"><div class="panel-head"><h2>${icon("files")}最近单据</h2><span>全部类型</span></div><table class="data-table"><thead><tr><th>单据</th><th>客户</th><th>金额</th><th>更新时间</th><th>状态</th></tr></thead><tbody>
        <tr><td><strong>PI-2026-0718</strong></td><td>Kanto Retail</td><td>$36,000</td><td>17:12</td><td><span class="status amber">草稿</span></td></tr>
        <tr><td><strong>QT-2026-0717</strong></td><td>Alpine Technik</td><td>$52,400</td><td>昨天</td><td><span class="status mint">已发送</span></td></tr>
        <tr><td><strong>CI-2026-0712</strong></td><td>Helix Automation</td><td>$44,800</td><td>7 月 23 日</td><td><span class="status mint">已确认</span></td></tr>
      </tbody></table></section>
      <section class="panel"><div class="panel-head"><h2>${icon("file-plus-2")}快速创建</h2><span>使用客户与商机数据</span></div><div class="panel-body search-form">
        <div class="field"><label>单据类型</label><select class="select"><option>Proforma Invoice</option><option>Quotation</option><option>Commercial Invoice</option></select></div>
        <div class="field"><label>客户或商机</label><input class="input" value="Kanto Retail / Nordic Tools 年度采购"></div>
        <div class="field"><label>模板</label><select class="select"><option>Standard Export · USD</option></select></div>
        <button class="button primary" type="button" data-action="单据草稿已创建">${icon("arrow-right")}创建并编辑</button>
      </div></section>
    </div>`;
}

function reportsView() {
  return `
    ${metricStrip([["新增线索", "328", "本月目标完成 82%"], ["有效商机", "19", "转化率 5.8%"], ["签约金额", "$184k", "本月已赢单 4 笔", "positive"], ["平均成交周期", "31 天", "较上季缩短 6 天"]])}
    <div class="layout-2">
      <section class="panel"><div class="panel-head"><h2>${icon("chart-no-axes-combined")}获客到成交</h2><span>2026 年 7 月</span></div><div class="panel-body pipeline-mini" style="padding-block:24px">
        <div class="pipeline-mini-row"><span>新增线索</span><div class="line-track"><i style="--value:100%"></i></div><b>328</b></div>
        <div class="pipeline-mini-row"><span>有效沟通</span><div class="line-track"><i style="--value:46%"></i></div><b>151</b></div>
        <div class="pipeline-mini-row"><span>创建商机</span><div class="line-track"><i style="--value:19%"></i></div><b>62</b></div>
        <div class="pipeline-mini-row"><span>赢单</span><div class="line-track"><i style="--value:7%"></i></div><b>24</b></div>
      </div></section>
      <section class="panel"><div class="panel-head"><h2>${icon("trophy")}团队表现</h2><span>本月</span></div><div class="action-list">
        <div class="action-row"><i></i><div><b>Alex</b><span>赢单 3 笔 · $82k</span></div><time>112%</time></div>
        <div class="action-row"><i class="mint"></i><div><b>Maria</b><span>赢单 2 笔 · $61k</span></div><time>94%</time></div>
        <div class="action-row"><i class="amber"></i><div><b>Kevin</b><span>赢单 1 笔 · $41k</span></div><time>78%</time></div>
      </div></section>
    </div>`;
}

function trainingView() {
  return `
    ${metricStrip([["训练中", "8", "覆盖 6 名业务员"], ["已沉淀样本", "1,842", "来自真实沟通记录"], ["本月提升", "+12.6%", "有效回复率", "positive"], ["待审核策略", "14", "需要经理确认"]])}
    <div class="layout-2">
      <section class="panel"><div class="panel-head"><h2>${icon("dumbbell")}训练计划</h2><span>持续训练</span></div><div class="action-list">
        <div class="action-row"><i></i><div><b>德国工业客户首次开发信</b><span>采集优秀样本 126 条，当前第 4 轮评估</span></div><span class="status amber">训练中</span></div>
        <div class="action-row"><i class="mint"></i><div><b>报价后异议处理</b><span>已形成 8 条可复用策略，等待经理审核</span></div><span class="status mint">已完成</span></div>
        <div class="action-row"><i class="amber"></i><div><b>WhatsApp 快速破冰</b><span>样本量不足，继续收集有效对话</span></div><span class="status">采集中</span></div>
      </div></section>
      <section class="panel"><div class="panel-head"><h2>${icon("user-round-check")}业务员能力卡</h2><span>训练结果</span></div><div class="panel-body">
        <div class="table-company"><span class="company-logo">AL</span><span><strong>Alex</strong><small>工业自动化 · 欧洲市场</small></span></div>
        <div class="pipeline-mini" style="margin-top:18px"><div class="pipeline-mini-row"><span>需求识别</span><div class="line-track"><i style="--value:88%"></i></div><b>88</b></div><div class="pipeline-mini-row"><span>异议处理</span><div class="line-track"><i style="--value:76%"></i></div><b>76</b></div><div class="pipeline-mini-row"><span>推进节奏</span><div class="line-track"><i style="--value:81%"></i></div><b>81</b></div></div>
      </div></section>
    </div>`;
}

function settingsView() {
  return `<div class="settings-layout">
    <nav class="settings-nav"><button class="active">组织信息</button><button>成员与团队</button><button>角色权限</button><button>AI 模型</button><button>获客来源</button><button>Communication</button><button>数据与备份</button></nav>
    <section class="settings-main"><h2>组织信息</h2><p>用于开发信、单据和 AI 生成内容的基础资料。</p>
      <div class="settings-section"><h3>公司资料</h3><div class="setting-row"><div><b>公司名称</b><span>显示在单据和正式外发内容中</span></div><input class="input" value="GoodJob Industrial Co., Ltd."></div><div class="setting-row"><div><b>公司网站</b><span>用于客户背调与外发签名</span></div><input class="input" value="https://www.goodjob.example"></div></div>
      <div class="settings-section"><h3>业务策略</h3><div class="setting-row"><div><b>自动保存业务数据</b><span>表单和任务过程写入 MySQL</span></div><button class="toggle on" type="button" aria-label="自动保存业务数据"></button></div><div class="setting-row"><div><b>允许本地数据库备份</b><span>关闭后用户无法创建服务器本地备份</span></div><button class="toggle" type="button" aria-label="允许本地数据库备份"></button></div></div>
    </section>
  </div>`;
}

function genericView(view) {
  const content = {
    reminders: ["跟进提醒", "按客户、商机与业务规则统一管理提醒。", "bell-ring"],
    memos: ["备忘录", "记录个人业务判断和待验证信息。", "notebook-pen"],
    knowledge: ["资料维护", "维护产品、市场与销售资料。", "library-big"],
    exam: ["在线考试", "根据团队知识与业务要求组织考试。", "clipboard-check"],
    "daily-reports": ["团队日报", "汇总团队每日进展、风险和计划。", "calendar-range"],
    imports: ["导入导出", "迁移客户、线索、商机和历史数据库数据。", "arrow-left-right"],
    skills: ["Agent Skills", "查看系统介绍、业务流程与工具技能。", "blocks"]
  }[view] || ["业务模块", "该模块沿用统一工作区设计。", "layout-template"];
  return `<section class="panel empty-state"><div><span class="empty-icon">${icon(content[2])}</span><h2>${content[0]}</h2><p>${content[1]}</p><button class="button primary" type="button" data-action="已创建新记录">${icon("plus")}新建</button></div></section>`;
}

const renderers = {
  dashboard: dashboardView,
  "lead-finder": leadFinderView,
  "prospect-list": () => customerTableView("prospect-list"),
  leads: () => customerTableView("leads"),
  customers: () => customerTableView("customers"),
  pipeline: pipelineView,
  "customer-pool": poolView,
  communication: communicationView,
  agent: agentView,
  documents: documentsView,
  reports: reportsView,
  training: trainingView,
  settings: settingsView
};

let currentView = "dashboard";
let toastTimer = null;

function refreshIcons() {
  if (window.lucide) {
    window.lucide.createIcons({ attrs: { "stroke-width": 1.7 } });
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.querySelector("span").textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2200);
}

function metaFor(view) {
  if (viewMeta[view]) return viewMeta[view];
  const labels = {
    reminders: ["跟进提醒", "按客户和商机集中管理业务提醒。"],
    memos: ["备忘录", "记录个人业务判断与待验证信息。"],
    knowledge: ["资料维护", "维护产品、市场和销售知识。"],
    exam: ["在线考试", "检验团队知识掌握与业务能力。"],
    "daily-reports": ["团队日报", "汇总团队当天进展、风险与计划。"],
    imports: ["导入导出", "迁移客户、线索、商机和数据库数据。"],
    skills: ["Agent Skills", "查看并管理小K可以使用的技能。"]
  };
  const [title, subtitle] = labels[view] || ["业务模块", "使用统一工作区完成当前业务。"];
  return { breadcrumb: title, title, subtitle, actions: [["新建", "plus", "primary"]] };
}

function switchView(view) {
  currentView = view;
  window.scrollTo(0, 0);
  const meta = metaFor(view);
  document.getElementById("breadcrumbTitle").textContent = meta.breadcrumb;
  document.getElementById("pageTitle").textContent = meta.title;
  document.getElementById("pageSubtitle").textContent = meta.subtitle;
  document.getElementById("pageActions").innerHTML = actionButtons(meta.actions);

  document.querySelectorAll("[data-view]").forEach(button => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  const activeSub = document.querySelector(`.nav-sublist [data-view="${view}"]`);
  if (activeSub) activeSub.closest("details").open = true;

  const stage = document.getElementById("viewStage");
  stage.style.animation = "none";
  void stage.offsetWidth;
  stage.style.animation = "";
  stage.innerHTML = (renderers[view] || (() => genericView(view)))();
  refreshIcons();
}

function openCommand() {
  const dialog = document.getElementById("commandDialog");
  if (!dialog.open) dialog.showModal();
  document.getElementById("commandInput").focus();
}

document.addEventListener("click", event => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    switchView(viewButton.dataset.view);
    return;
  }

  const commandView = event.target.closest("[data-command-view]");
  if (commandView) {
    document.getElementById("commandDialog").close();
    switchView(commandView.dataset.commandView);
    return;
  }

  const action = event.target.closest("[data-action]");
  if (action) {
    showToast(action.dataset.action);
    return;
  }

  const segment = event.target.closest(".segmented button");
  if (segment) {
    segment.closest(".segmented").querySelectorAll("button").forEach(button => button.classList.remove("active"));
    segment.classList.add("active");
    return;
  }

  const conversation = event.target.closest(".conversation");
  if (conversation) {
    conversation.closest(".conversation-list").querySelectorAll(".conversation").forEach(item => item.classList.remove("active"));
    conversation.classList.add("active");
    return;
  }

  const toggle = event.target.closest(".toggle");
  if (toggle) {
    toggle.classList.toggle("on");
    showToast("设置已更新");
  }
});

document.getElementById("sidebarToggle").addEventListener("click", () => {
  document.getElementById("appShell").classList.toggle("sidebar-collapsed");
});

document.getElementById("commandSearch").addEventListener("click", openCommand);
document.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openCommand();
  }
});

document.getElementById("commandInput").addEventListener("input", event => {
  const query = event.target.value.trim().toLowerCase();
  document.querySelectorAll(".command-results button").forEach(button => {
    button.hidden = query && !button.textContent.toLowerCase().includes(query);
  });
});

document.addEventListener("click", event => {
  if (event.target.closest("#sendChat")) {
    const input = document.getElementById("chatInput");
    if (!input || !input.value.trim()) return;
    const stage = document.getElementById("messageStage");
    stage.insertAdjacentHTML("beforeend", `<div class="message mine">${input.value.trim()}<time>刚刚</time></div>`);
    input.value = "";
    stage.scrollTop = stage.scrollHeight;
  }

  if (event.target.closest("#agentSend")) {
    const input = document.getElementById("agentInput");
    if (!input || !input.value.trim()) return;
    const messages = document.getElementById("agentMessages");
    messages.insertAdjacentHTML("beforeend", `<div class="agent-message user"><b>你</b><p>${input.value.trim()}</p></div><div class="agent-message"><b>小K</b><p>我正在理解目标并匹配可执行工具，新的动作会显示在右侧执行过程中。</p></div>`);
    input.value = "";
    messages.scrollTop = messages.scrollHeight;
  }
});

switchView(currentView);
refreshIcons();

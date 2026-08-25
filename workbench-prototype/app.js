const periodData = {
  today: {
    forecast: "$112k",
    growth: "18.6%",
    risk: "$54k",
    tasks: "12",
    leads: "28",
    contacts: "17",
    series: [42, 47, 45, 52, 58, 56, 66, 72, 70, 82, 88, 94]
  },
  week: {
    forecast: "$284k",
    growth: "12.4%",
    risk: "$76k",
    tasks: "38",
    leads: "96",
    contacts: "64",
    series: [38, 44, 52, 49, 61, 66, 70, 76, 82, 80, 91, 98]
  },
  month: {
    forecast: "$426k",
    growth: "24.8%",
    risk: "$91k",
    tasks: "146",
    leads: "328",
    contacts: "151",
    series: [31, 38, 46, 43, 55, 62, 68, 73, 79, 87, 92, 100]
  }
};

const shell = document.getElementById("shell");
const toast = document.getElementById("toast");
const commandDialog = document.getElementById("commandDialog");
let toastTimer;
let forecastChart;
let funnelChart;

function showToast(message) {
  toast.querySelector("span").textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2200);
}

function renderForecast(series) {
  if (!window.echarts) return;
  if (!forecastChart) forecastChart = window.echarts.init(document.getElementById("forecastChart"));
  forecastChart.setOption({
    animationDuration: 650,
    grid: { left: 4, right: 4, top: 22, bottom: 14 },
    xAxis: { type: "category", boundaryGap: false, data: series.map((_, index) => index + 1), show: false },
    yAxis: { type: "value", show: false, min: 20 },
    series: [{
      type: "line",
      data: series,
      smooth: 0.36,
      symbol: "none",
      lineStyle: { color: "#ffffff", width: 2.4 },
      areaStyle: { color: "rgba(255,255,255,.13)" },
      markPoint: { symbol: "circle", symbolSize: 8, label: { show: false }, itemStyle: { color: "#ffffff", borderColor: "#3157c8", borderWidth: 2 }, data: [{ coord: [series.length - 1, series.at(-1)] }] }
    }]
  });
}

function renderFunnel() {
  if (!window.echarts) return;
  funnelChart = window.echarts.init(document.getElementById("funnelChart"));
  funnelChart.setOption({
    animationDuration: 700,
    tooltip: { trigger: "item" },
    series: [{
      type: "funnel",
      left: "13%",
      top: 18,
      bottom: 12,
      width: "74%",
      min: 0,
      max: 4,
      minSize: "22%",
      maxSize: "100%",
      sort: "descending",
      gap: 5,
      label: { show: true, position: "inside", color: "#ffffff", fontSize: 9, formatter: "{b}  {c}" },
      labelLine: { show: false },
      itemStyle: { borderColor: "#fbfcfd", borderWidth: 2 },
      emphasis: { scale: true, scaleSize: 4 },
      data: [
        { value: 4, name: "进入系统", itemStyle: { color: "#3157c8" } },
        { value: 2, name: "待清洗", itemStyle: { color: "#3f5fb9" } },
        { value: 2, name: "有效线索", itemStyle: { color: "#4d64a2" } },
        { value: 0.4, name: "转为客户", itemStyle: { color: "#356b65" } }
      ]
    }]
  });
}

function setPeriod(period) {
  const data = periodData[period];
  document.getElementById("forecastValue").textContent = data.forecast;
  document.getElementById("forecastGrowth").textContent = data.growth;
  document.getElementById("riskMetric").textContent = data.risk;
  document.getElementById("taskMetric").textContent = data.tasks;
  document.getElementById("leadMetric").textContent = data.leads;
  document.getElementById("contactMetric").textContent = data.contacts;
  renderForecast(data.series);
}

function updateTaskProgress() {
  const tasks = [...document.querySelectorAll(".task-row")];
  const done = tasks.filter(task => task.querySelector("input").checked).length;
  document.getElementById("doneCount").textContent = String(done);
  document.getElementById("taskProgress").style.width = `${(done / tasks.length) * 100}%`;
  tasks.forEach(task => task.classList.toggle("done", task.querySelector("input").checked));
}

document.getElementById("sidebarToggle").addEventListener("click", () => shell.classList.toggle("collapsed"));
document.getElementById("globalSearch").addEventListener("click", () => {
  commandDialog.showModal();
  document.getElementById("commandInput").focus();
});

document.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    commandDialog.showModal();
    document.getElementById("commandInput").focus();
  }
});

document.querySelectorAll("[data-period]").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-period]").forEach(item => item.classList.toggle("active", item === button));
    setPeriod(button.dataset.period);
  });
});

document.querySelectorAll("[data-toast]").forEach(button => {
  button.addEventListener("click", () => {
    showToast(button.dataset.toast);
    if (button.closest("dialog")) commandDialog.close();
  });
});

document.querySelectorAll(".task-row input").forEach(input => input.addEventListener("change", updateTaskProgress));

document.getElementById("meetingMode").addEventListener("click", () => {
  document.body.classList.toggle("meeting-mode");
  const enabled = document.body.classList.contains("meeting-mode");
  document.getElementById("meetingMode").innerHTML = enabled ? '<i class="ti ti-arrow-back"></i>退出晨会' : '<i class="ti ti-presentation"></i>晨会模式';
  window.setTimeout(() => { forecastChart?.resize(); funnelChart?.resize(); }, 260);
});

document.getElementById("newTask").addEventListener("click", () => showToast("新建待办面板已打开"));
document.getElementById("addQuickTask").addEventListener("click", () => showToast("快速新增已准备"));
document.querySelectorAll(".priority-row").forEach(row => row.addEventListener("click", () => showToast(`正在打开优先级 ${row.dataset.priority} 的商机`)));

document.getElementById("commandInput").addEventListener("input", event => {
  const query = event.target.value.trim().toLowerCase();
  document.querySelectorAll(".command-list button").forEach(button => {
    button.hidden = query && !button.textContent.toLowerCase().includes(query);
  });
});

window.addEventListener("resize", () => {
  forecastChart?.resize();
  funnelChart?.resize();
});

renderForecast(periodData.today.series);
renderFunnel();
updateTaskProgress();

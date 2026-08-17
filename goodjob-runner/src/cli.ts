#!/usr/bin/env node
import { hostname } from "node:os";
import { codexCodeModeHost, resolveCodexBinary } from "./codex-adapter.js";
import { browserServiceConfiguration, isBrowserCdpReady, isBrowserMcpReady, startBrowserService } from "./browser-service.js";
import { GoodJobRunnerClient } from "./client.js";
import { loadConfig, normalizeServerUrl, normalizeWorkspace, runnerConfigPath, saveConfig } from "./config.js";
import { detectCodexVersion, runnerIdentity, RUNNER_VERSION, runOneClaim, startRunner } from "./runner.js";

function values(args: string[], name: string) {
  const found: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) found.push(args[index + 1]);
    if (args[index].startsWith(`${name}=`)) found.push(args[index].slice(name.length + 1));
  }
  return found;
}

const value = (args: string[], name: string) => values(args, name).at(-1) || "";

function usage() {
  console.log(`GoodJob Local Runner ${RUNNER_VERSION}

用法：
  goodjob-runner pair --server <CRM地址> --code <配对码> --workspace <绝对路径> [--workspace <路径>]
  goodjob-runner start
  goodjob-runner once
  goodjob-runner status
  goodjob-runner doctor`);
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) { usage(); return; }
  if (command === "pair") {
    const serverUrl = normalizeServerUrl(value(args, "--server"));
    const code = value(args, "--code").trim();
    const rawWorkspaces = values(args, "--workspace");
    if (!code || !rawWorkspaces.length) throw new Error("配对需要 --code 和至少一个 --workspace");
    const workspaces = [...new Set(await Promise.all(rawWorkspaces.map(normalizeWorkspace)))];
    const displayName = value(args, "--name") || `${hostname()} · Codex`;
    const identity = await runnerIdentity(workspaces);
    if (!identity.codexVersion) throw new Error("本机未检测到 Codex CLI，请先安装并完成 codex login");
    const client = new GoodJobRunnerClient({ serverUrl });
    const paired = await client.pair({ ...identity, code, displayName });
    await saveConfig({ serverUrl, runnerId: paired.runner.id, token: paired.token, displayName: paired.runner.displayName, workspaces, createdAt: new Date().toISOString() });
    console.log(`配对成功：${paired.runner.displayName}`);
    console.log(`授权目录：${workspaces.join(", ")}`);
    console.log(`配置文件：${runnerConfigPath()}`);
    return;
  }

  const config = await loadConfig();
  if (command === "status" || command === "doctor") {
    const codexVersion = await detectCodexVersion();
    const codexBinary = resolveCodexBinary();
    const client = new GoodJobRunnerClient({ serverUrl: config.serverUrl, token: config.token });
    const state = await client.heartbeat({ ...(await runnerIdentity(config.workspaces)), lastError: "" });
    console.log(`CRM：${config.serverUrl}`);
    console.log(`设备：${config.displayName}`);
    console.log(`Codex：${codexVersion || "未检测到"}`);
    if (command === "doctor") {
      const browser = browserServiceConfiguration();
      console.log(`执行文件：${codexBinary}`);
      console.log(`工具宿主：${codexCodeModeHost(codexBinary) || "缺失（终端与浏览器工具不可用）"}`);
      console.log(`独立浏览器：${await isBrowserMcpReady(browser) ? "运行中" : "未运行（启动 Runner 后自动运行）"}`);
      console.log(`独立 Chrome：${await isBrowserCdpReady(browser) ? "运行中" : "未运行"}`);
      console.log(`浏览器 MCP：${browser.url}`);
      console.log(`Chrome CDP：${browser.cdpUrl}（仅本机）`);
      console.log(`浏览器资料：${browser.dataDir}`);
    }
    console.log(`目录：${config.workspaces.join(", ")}`);
    console.log(`连接：${state.ok ? "正常" : "异常"}`);
    return;
  }
  if (command === "once") {
    const browserService = await startBrowserService();
    try {
      console.log(await runOneClaim(config, undefined, browserService.configuration.url) ? "任务执行完成" : "当前没有待执行任务");
    } finally {
      await browserService.stop();
    }
    return;
  }
  if (command === "start") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(`GoodJob Runner 已连接 ${config.serverUrl}，等待任务...`);
    await startRunner(config, controller.signal);
    return;
  }
  usage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Runner 启动失败");
  process.exitCode = 1;
});

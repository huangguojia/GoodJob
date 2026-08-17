import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8931;
const DEFAULT_CDP_PORT = 8933;
const START_TIMEOUT_MS = 15_000;
const require = createRequire(import.meta.url);

export interface BrowserServiceConfiguration {
  host: string;
  port: number;
  url: string;
  cdpPort: number;
  cdpUrl: string;
  dataDir: string;
  outputDir: string;
  proxyServer: string;
  executablePath: string;
}

export interface BrowserService {
  configuration: BrowserServiceConfiguration;
  pid: number | undefined;
  browserPid: number | undefined;
  stop(): Promise<void>;
}

type BrowserServiceOverrides = Partial<Omit<BrowserServiceConfiguration, "url" | "cdpUrl">>;

function portFromEnvironment(raw: string | undefined, fallback: number, variableName: string) {
  const port = Number(raw || fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`${variableName} 必须是 1024 到 65535 之间的整数`);
  }
  return port;
}

export function browserExecutablePath(environment: NodeJS.ProcessEnv = process.env) {
  const configured = environment.GOODJOB_BROWSER_EXECUTABLE || "";
  const fromPath = String(environment.PATH || "").split(path.delimiter).flatMap((directory) => [
    path.join(directory, "google-chrome"),
    path.join(directory, "google-chrome-stable"),
    path.join(directory, "chromium"),
    path.join(directory, "chromium-browser")
  ]);
  const candidates = [
    configured,
    ...(process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] : []),
    ...(process.platform === "win32" ? [
      path.join(environment.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(environment["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe")
    ] : []),
    ...fromPath
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("未找到可用的 Google Chrome/Chromium，请安装浏览器或设置 GOODJOB_BROWSER_EXECUTABLE");
  return executable;
}

export function browserServiceConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  overrides: BrowserServiceOverrides = {}
): BrowserServiceConfiguration {
  const host = overrides.host || DEFAULT_HOST;
  if (host !== DEFAULT_HOST) throw new Error("独立浏览器服务只允许绑定 127.0.0.1");
  const port = overrides.port ?? portFromEnvironment(environment.GOODJOB_BROWSER_MCP_PORT, DEFAULT_PORT, "GOODJOB_BROWSER_MCP_PORT");
  const cdpPort = overrides.cdpPort ?? portFromEnvironment(environment.GOODJOB_BROWSER_CDP_PORT, DEFAULT_CDP_PORT, "GOODJOB_BROWSER_CDP_PORT");
  if (port === cdpPort) throw new Error("浏览器 MCP 端口和 CDP 端口不能相同");
  const dataDir = overrides.dataDir || environment.GOODJOB_BROWSER_DATA_DIR || path.join(homedir(), ".goodjob", "browser-profile");
  const outputDir = overrides.outputDir || environment.GOODJOB_BROWSER_OUTPUT_DIR || path.join(homedir(), ".goodjob", "browser-output");
  return {
    host,
    port,
    url: `http://${host}:${port}/mcp`,
    cdpPort,
    cdpUrl: `http://${host}:${cdpPort}`,
    dataDir: path.resolve(dataDir),
    outputDir: path.resolve(outputDir),
    proxyServer: overrides.proxyServer ?? environment.GOODJOB_BROWSER_PROXY_SERVER ?? "",
    executablePath: overrides.executablePath || browserExecutablePath(environment)
  };
}

export function browserMcpCliPath() {
  return path.join(path.dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
}

function isPortReachable(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function isBrowserServiceReachable(configuration = browserServiceConfiguration(), timeoutMs = 500) {
  return isPortReachable(configuration.host, configuration.port, timeoutMs);
}

export async function isBrowserCdpReady(configuration = browserServiceConfiguration(), timeoutMs = 1_500) {
  try {
    const response = await fetch(`${configuration.cdpUrl}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    const value = await response.json() as Record<string, unknown>;
    return response.ok && typeof value.webSocketDebuggerUrl === "string";
  } catch {
    return false;
  }
}

export async function isBrowserMcpReady(
  configuration = browserServiceConfiguration(),
  timeoutMs = 1_500
) {
  try {
    const response = await fetch(configuration.url, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "goodjob-runner-health", version: "1" }
        }
      })
    });
    const body = await response.text();
    return response.ok && body.includes('"name":"Playwright"');
  } catch {
    return false;
  }
}

function waitForExit(child: ChildProcess) {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode) resolve();
    else child.once("close", () => resolve());
  });
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  const force = setTimeout(() => {
    if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
  }, 3_000);
  force.unref();
  await waitForExit(child);
  clearTimeout(force);
}

export async function startBrowserService(
  overrides: BrowserServiceOverrides = {}
): Promise<BrowserService> {
  const configuration = browserServiceConfiguration(process.env, overrides);
  if (await isBrowserServiceReachable(configuration)) {
    throw new Error(`浏览器 MCP 端口 ${configuration.port} 已被占用，请停止重复的 Runner 或修改 GOODJOB_BROWSER_MCP_PORT`);
  }
  if (await isPortReachable(configuration.host, configuration.cdpPort)) {
    throw new Error(`浏览器 CDP 端口 ${configuration.cdpPort} 已被占用，请停止重复的 Runner 或修改 GOODJOB_BROWSER_CDP_PORT`);
  }
  await Promise.all([
    mkdir(configuration.dataDir, { recursive: true, mode: 0o700 }),
    mkdir(configuration.outputDir, { recursive: true, mode: 0o700 })
  ]);
  await Promise.all([chmod(configuration.dataDir, 0o700), chmod(configuration.outputDir, 0o700)]);

  const browserArgs = [
    `--remote-debugging-address=${configuration.host}`,
    `--remote-debugging-port=${configuration.cdpPort}`,
    `--user-data-dir=${configuration.dataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-sync"
  ];
  if (configuration.proxyServer) browserArgs.push(`--proxy-server=${configuration.proxyServer}`);
  if (process.env.NODE_ENV === "test") browserArgs.push("--headless=new", "--disable-gpu");
  browserArgs.push("about:blank");
  const browserChild = spawn(configuration.executablePath, browserArgs, {
    cwd: configuration.outputDir,
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let browserDiagnostics = "";
  const captureBrowser = (chunk: Buffer) => { browserDiagnostics = `${browserDiagnostics}${chunk.toString("utf8")}`.slice(-6_000); };
  browserChild.stdout?.on("data", captureBrowser);
  browserChild.stderr?.on("data", captureBrowser);
  const browserDeadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < browserDeadline && browserChild.exitCode === null && !browserChild.signalCode) {
    if (await isBrowserCdpReady(configuration, 500)) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!(await isBrowserCdpReady(configuration, 1_000))) {
    await stopChild(browserChild);
    throw new Error(`独立 Chrome 启动失败${browserDiagnostics.trim() ? `：${browserDiagnostics.trim()}` : ""}`);
  }

  const args = [
    browserMcpCliPath(),
    "--host", configuration.host,
    "--port", String(configuration.port),
    "--cdp-endpoint", configuration.cdpUrl,
    "--cdp-timeout", "30000",
    "--output-dir", configuration.outputDir,
    "--output-max-size", "52428800",
    "--shared-browser-context",
    "--block-service-workers",
    "--image-responses", "omit",
    "--timeout-action", "10000",
    "--timeout-navigation", "60000",
    "--allowed-hosts", `${configuration.host}:${configuration.port},localhost:${configuration.port}`
  ];
  const child = spawn(process.execPath, args, {
    cwd: configuration.outputDir,
    env: { ...process.env, NO_COLOR: "1" },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let diagnostics = "";
  const capture = (chunk: Buffer) => { diagnostics = `${diagnostics}${chunk.toString("utf8")}`.slice(-6_000); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline && child.exitCode === null && !child.signalCode) {
    if (await isBrowserMcpReady(configuration, 500)) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!(await isBrowserMcpReady(configuration, 1_000))) {
    await stopChild(child);
    await stopChild(browserChild);
    throw new Error(`独立浏览器服务启动失败${diagnostics.trim() ? `：${diagnostics.trim()}` : ""}`);
  }

  let stopped = false;
  return {
    configuration,
    pid: child.pid,
    browserPid: browserChild.pid,
    async stop() {
      if (stopped) return;
      stopped = true;
      await stopChild(child);
      await stopChild(browserChild);
    }
  };
}

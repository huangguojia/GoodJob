# GoodJob Local Runner

GoodJob Local Runner 由本机主动连接 CRM，领取结构化 Codex 任务并把进度和结果回传到网页。它不会开放本机端口，也不接受任意 Shell 命令。

```bash
npm install
npm run build --workspace @goodjob/local-runner
npm link --workspace @goodjob/local-runner
goodjob-runner pair --server https://crm.example.com --code GJ-XXXX-XXXX-XXXX --workspace /absolute/project/path
goodjob-runner doctor
goodjob-runner start
```

本机配置保存在 `~/.goodjob/runner.json`，文件权限为 `0600`。可用 `GOODJOB_RUNNER_CONFIG` 指定其他位置，用 `GOODJOB_CODEX_BIN` 指定 Codex CLI 路径。

在 macOS 上，Runner 会优先使用 ChatGPT 桌面版内置的 Codex CLI，因为它与 `codex-code-mode-host` 成套发布，可正常执行终端工具。运行 `goodjob-runner doctor` 可以确认实际执行文件和工具宿主路径。

Runner 启动时会同时启动 GoodJob 独立受控浏览器：

- 使用 Playwright MCP 和本机 Google Chrome，不依赖 ChatGPT Chrome 扩展。
- MCP 与 Chrome 调试端口都只监听 `127.0.0.1`，不会向局域网或公网开放端口。
- 浏览器资料默认保存在 `~/.goodjob/browser-profile`，不会读取个人 Chrome 的历史、Cookie 或登录状态。
- 独立 Chrome 由 Runner 常驻管理；它自己的登录状态会保留，Codex 任务结束后页面保持打开，Runner 停止时浏览器才会关闭。
- 浏览器下载、截图等输出保存在 `~/.goodjob/browser-output`，旧输出超过 50 MB 后自动清理。

可选环境变量：`GOODJOB_BROWSER_MCP_PORT`、`GOODJOB_BROWSER_CDP_PORT`、`GOODJOB_BROWSER_DATA_DIR`、`GOODJOB_BROWSER_OUTPUT_DIR`、`GOODJOB_BROWSER_EXECUTABLE`、`GOODJOB_BROWSER_PROXY_SERVER`。

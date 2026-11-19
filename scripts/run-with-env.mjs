#!/usr/bin/env node
// 跨平台地「带环境变量执行命令」。
//
// 为什么需要它：`NODE_ENV=test tsx src/x.ts` 是 POSIX shell 语法，
// Windows 的 cmd.exe / PowerShell 会把它当成「执行一个叫 NODE_ENV=test 的程序」，
// 于是 npm test 在 Windows 上第一行就挂。项目要开源，不能要求用户先装 WSL。
//
// 用法：
//   node scripts/run-with-env.mjs NODE_ENV=test tsx src/file-storage-test.ts
//   node scripts/run-with-env.mjs NODE_ENV=test JWT_SECRET=abc tsx src/x.ts
//
// 值里允许带空格（用引号包起来即可），不需要额外依赖。

import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const env = { ...process.env };
let index = 0;
while (index < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(argv[index])) {
  const eq = argv[index].indexOf("=");
  env[argv[index].slice(0, eq)] = argv[index].slice(eq + 1);
  index += 1;
}

const command = argv[index];
const args = argv.slice(index + 1);
if (!command) {
  console.error("用法: node scripts/run-with-env.mjs KEY=VALUE... <command> [args...]");
  process.exit(2);
}

// Windows 上 node_modules/.bin/tsx 是 .cmd，不带 shell 直接 spawn 会 ENOENT
const child = spawn(command, args, {
  stdio: "inherit",
  env,
  shell: process.platform === "win32"
});

child.on("error", (error) => {
  console.error(`[run-with-env] 启动失败：${error.message}`);
  process.exit(127);
});

child.on("exit", (code, signal) => {
  if (signal) {
    // 透传信号，让外层（npm / CI）看到真实的中断原因
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

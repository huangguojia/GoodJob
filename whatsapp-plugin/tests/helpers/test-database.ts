import path from "node:path";

/**
 * 回测统一使用的 PGlite 数据目录：**内存文件系统**（`memory://`）。
 *
 * 为什么不是临时目录下的落盘库：
 * - 落盘 PGlite 每建一个库都要跑一遍 initdb（上千个小文件），本机实测 **wall≈40 秒而 CPU 仅 4.2 秒**
 *   （时间全花在文件系统等待上），内存库只要 **1 秒**；
 * - 在 WorkBuddy 的沙箱里它还会直接失败：迁移阶段报
 *   `could not read blocks 0..0 in file "base/5/3455": Invalid seek`（md.c），
 *   8 个测试文件因此在 `beforeAll` 挂掉（`Hook timed out in 30000ms`），
 *   并连带 `afterAll` 里 `runtime` 还没赋值就调用而报 `undefined.close`，
 *   整套回测从 1 分钟劣化到 15 分钟还大面积失败。沙箱把文件操作代理给宿主 broker
 *   （`node-brokered-fs-shim`），已实测它对 `<tmpdir>` 的 `mkdir` 直接拒绝，
 *   落盘 PGlite 的 `Invalid seek` 同源；换成内存文件系统后完全不碰宿主 FS，问题消失。
 *
 * 回测里没有一条用例依赖「数据落盘后重开还在」。真要验持久化与跨进程可见性，那是
 * `mysql.integration.test.ts` / `postgres-to-mysql.integration.test.ts`（真实 MySQL）的职责。
 *
 * ⚠️ `mediaStoragePath` 必须一起给，且**必须落在工作区里**（`.data/test-media/<唯一名>`）：
 * `path.dirname("memory://")` 是 `.`，不显式指定时媒体目录会落在仓库根目录里；而放进系统临时目录
 * 在沙箱里会直接失败——vitest worker 里对 `<tmpdir>` 的 `mkdir` 会抛
 * `Brokered host mkdir requires an available runtime file rule`（`MediaStorageService.initialize`）。
 * `.data/` 已在版本控制之外，回测产物放这里不会弄脏工作副本。
 */
export const IN_MEMORY_PGLITE = "memory://";

export function inMemoryDatabasePaths(scratchDir: string): { pglitePath: string; mediaStoragePath: string } {
  return {
    pglitePath: IN_MEMORY_PGLITE,
    mediaStoragePath: path.join(process.cwd(), ".data", "test-media", path.basename(scratchDir))
  };
}

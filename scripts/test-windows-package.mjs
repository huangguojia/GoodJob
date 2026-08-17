import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const archive = path.resolve(process.argv[2] || "");
if (!archive || !statSync(archive).isFile()) throw new Error("请提供 Windows 便携包 ZIP");
const temporary = mkdtempSync(path.join(tmpdir(), "goodjob-windows-package-test-"));

function filesUnder(root) {
  const output = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, name.name);
      if (name.isDirectory()) visit(full);
      else output.push(full);
    }
  };
  visit(root);
  return output;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

try {
  execFileSync("unzip", ["-q", archive, "-d", temporary]);
  const roots = readdirSync(temporary, { withFileTypes: true }).filter((item) => item.isDirectory());
  if (roots.length !== 1) throw new Error("ZIP 必须只有一个顶层目录");
  const root = path.join(temporary, roots[0].name);
  const app = path.join(root, "app");
  const required = [
    "START-GOODJOB.cmd", "STOP-GOODJOB.cmd", "DIAGNOSE-GOODJOB.cmd", "UPDATE-GOODJOB.cmd",
    "runtime/node/node.exe", "runtime/mariadb/bin/mariadbd.exe", "runtime/mariadb/bin/mariadb.exe",
    "runtime/mariadb/bin/mariadb-dump.exe", "runtime/update-public-key.pem",
    "app/backend/dist/server.js", "app/backend/dist/migrate-mysql.js", "app/frontend/dist/index.html",
    "app/communication/dist/index.html", "app/communication/dist-server/server/index.js"
  ];
  for (const item of required) statSync(path.join(root, item));
  for (const item of [
    "app/node_modules/@electric-sql/pglite",
    "app/node_modules/pg",
    "app/communication/dist-server/server/scripts/migrate-postgres-to-mysql.js"
  ]) {
    if (existsSync(path.join(root, item))) throw new Error(`Windows MySQL 包含非必要数据库组件：${item}`);
  }
  for (const binary of ["runtime/node/node.exe", "runtime/mariadb/bin/mariadbd.exe"]) {
    if (readFileSync(path.join(root, binary)).subarray(0, 2).toString("ascii") !== "MZ") throw new Error(`${binary} 不是 Windows PE 文件`);
  }

  const manifestFile = path.join(app, "PACKAGE-MANIFEST.sha256");
  const expected = new Map(readFileSync(manifestFile, "utf8").trim().split(/\r?\n/u).map((line) => {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
    if (!match) throw new Error("PACKAGE-MANIFEST.sha256 格式错误");
    return [match[2], match[1]];
  }));
  const actualFiles = filesUnder(app).filter((file) => path.resolve(file) !== path.resolve(manifestFile));
  if (actualFiles.length !== expected.size) throw new Error("应用文件数量与完整性清单不一致");
  for (const file of actualFiles) {
    const relative = path.relative(app, file).split(path.sep).join("/");
    const expectedHash = expected.get(relative);
    if (!expectedHash) throw new Error(`完整性清单未登记文件：${relative}`);
    if (sha256(file) !== expectedHash) throw new Error(`文件校验失败：${relative}`);
  }

  const forbidden = actualFiles.filter((file) => {
    const relative = path.relative(app, file).split(path.sep).join("/");
    return /(^|\/)(\.git|\.svn)(\/|$)|^(?:backend|frontend|communication)\/src\/|\.env(?:\.|$)|\.(?:sql|log|map|d\.ts|test\.js|spec\.js)$|(?:^|\/)[^/]+-test\.js$/iu.test(relative);
  });
  if (forbidden.length) throw new Error(`包内含禁止文件：${forbidden.slice(0, 5).join(", ")}`);
  const nativeModules = actualFiles.filter((file) => file.endsWith(".node"));
  if (nativeModules.some((file) => !file.includes("win32-x64"))) throw new Error("包含非 Windows x64 原生模块");

  const scripts = filesUnder(path.join(root, "runtime")).filter((file) => /\.(?:ps1|psm1)$/u.test(file)).map((file) => readFileSync(file, "utf8")).join("\n");
  for (const unsafe of ["taskkill /f /im node.exe", "admin123456", "goodjob_local", "GoodJobCRMDefaultSecretKey"]) {
    if (scripts.includes(unsafe)) throw new Error(`启动器仍包含危险降级值：${unsafe}`);
  }
  console.log(JSON.stringify({ ok: true, archive, files: actualFiles.length, nativeModules: nativeModules.length, bytes: statSync(archive).size }, null, 2));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

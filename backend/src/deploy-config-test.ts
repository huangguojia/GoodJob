import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeploySecrets } from "./deploy-config.js";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const dir = mkdtempSync(join(tmpdir(), "deploy-config-"));
try {
  check("文件不存在时不加载、不抛错", () => {
    delete process.env.JWT_SECRET;
    const result = loadDeploySecrets({ file: join(dir, "missing.json") });
    assert.equal(result.loaded, false);
    assert.equal(result.appliedKeys.length, 0);
  });

  check("合法文件：未设置的 env 被补齐", () => {
    delete process.env.JWT_SECRET;
    delete process.env.EMAIL_TRACKING_SECRET;
    delete process.env.EMAIL_TRACKING_BASE_URL;
    const file = join(dir, "ok.json");
    writeFileSync(file, JSON.stringify({
      JWT_SECRET: "deploy-test-jwt-secret-0123456789abcdef",
      EMAIL_TRACKING_SECRET: "deploy-test-tracking",
      EMAIL_TRACKING_BASE_URL: "https://crm.example.com/"
    }));
    const result = loadDeploySecrets({ file });
    assert.equal(result.loaded, true);
    assert.deepEqual(result.appliedKeys.sort(), ["EMAIL_TRACKING_BASE_URL", "EMAIL_TRACKING_SECRET", "JWT_SECRET"]);
    assert.equal(process.env.JWT_SECRET, "deploy-test-jwt-secret-0123456789abcdef");
    assert.equal(process.env.EMAIL_TRACKING_BASE_URL, "https://crm.example.com/");
  });

  check("URL 原样写入 env（尾部斜杠由 email-tracking 层负责归一）", () => {
    assert.equal(process.env.EMAIL_TRACKING_BASE_URL, "https://crm.example.com/");
  });

  check("已设置的环境变量不被覆盖（env 优先）", () => {
    process.env.JWT_SECRET = "env-wins-secret-0123456789abcdef";
    const file = join(dir, "env-first.json");
    writeFileSync(file, JSON.stringify({ JWT_SECRET: "file-loses-0123456789abcdefghijk" }));
    const result = loadDeploySecrets({ file });
    assert.equal(process.env.JWT_SECRET, "env-wins-secret-0123456789abcdef");
    assert.deepEqual(result.skippedKeys, ["JWT_SECRET"]);
    assert.equal(result.appliedKeys.length, 0);
    assert.equal(result.loaded, false);
  });

  check("非字符串与空白值被忽略", () => {
    delete process.env.EMAIL_TRACKING_SECRET;
    const file = join(dir, "noise.json");
    writeFileSync(file, JSON.stringify({ EMAIL_TRACKING_SECRET: "   ", JWT_SECRET: 123, OTHER: "x" }));
    const result = loadDeploySecrets({ file });
    assert.equal(result.appliedKeys.length, 0);
    assert.equal(process.env.EMAIL_TRACKING_SECRET, undefined);
  });

  check("损坏的 JSON 不抛错、不加载", () => {
    delete process.env.JWT_SECRET;
    const file = join(dir, "broken.json");
    writeFileSync(file, "{ not json");
    const result = loadDeploySecrets({ file });
    assert.equal(result.loaded, false);
    assert.equal(result.path, file);
  });

  check("JSON 数组内容被拒绝", () => {
    const file = join(dir, "array.json");
    writeFileSync(file, "[]");
    const result = loadDeploySecrets({ file });
    assert.equal(result.loaded, false);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.JWT_SECRET;
  delete process.env.EMAIL_TRACKING_SECRET;
  delete process.env.EMAIL_TRACKING_BASE_URL;
}

console.log(`deploy-config-test: ${passed} assertions passed`);

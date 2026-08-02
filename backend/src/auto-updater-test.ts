import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const temporary = mkdtempSync(path.join(tmpdir(), "goodjob-updater-test-"));
const appDirectory = path.join(temporary, "app");
const publicKeyFile = path.join(temporary, "update-public-key.pem");
mkdirSync(appDirectory, { recursive: true });
writeFileSync(path.join(appDirectory, "package.json"), JSON.stringify({ version: "1.2.4" }));

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }));
process.env.GOODJOB_DATA_DIR = path.join(temporary, "data");
process.env.GOODJOB_APP_DIR = appDirectory;
process.env.GOODJOB_UPDATE_PUBLIC_KEY = publicKeyFile;

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    packageFormatVersion: 2,
    latestVersion: "1.2.5",
    minimumVersion: "1.2.4",
    releases: {
      "1.2.5": {
        date: "2026-08-02",
        databaseCompatibility: "backward-compatible",
        windows: {
          url: "releases/1.2.5/goodjob-app-1.2.5-win-x64.zip",
          size: 2048,
          sha256: "a".repeat(64)
        },
        changelog: "Updater test"
      }
    },
    ...overrides
  };
}

let manifestBytes = Buffer.from(JSON.stringify(manifest(), null, 2));
let signature = sign(null, manifestBytes, privateKey).toString("base64");
const server = createServer((request, response) => {
  if (request.url === "/manifest.json") {
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": manifestBytes.byteLength });
    response.end(manifestBytes);
    return;
  }
  if (request.url === "/manifest.sig") {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end(signature);
    return;
  }
  response.writeHead(404).end();
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  assert(address && typeof address === "object");
  const mirror = `http://127.0.0.1:${address.port}`;
  const updater = await import("./auto-updater.js");

  updater.setMirrorUrl(mirror);
  const valid = await updater.checkForUpdate();
  assert.equal(valid.error, null);
  assert.equal(valid.currentVersion, "1.2.4");
  assert.equal(valid.latestVersion, "1.2.5");
  assert.equal(valid.hasUpdate, true);

  signature = Buffer.from("invalid signature").toString("base64");
  const invalidSignature = await updater.checkForUpdate();
  assert.match(invalidSignature.error || "", /签名无效/u);

  const incompatible = manifest();
  incompatible.releases["1.2.5"].databaseCompatibility = "requires-restore";
  manifestBytes = Buffer.from(JSON.stringify(incompatible, null, 2));
  signature = sign(null, manifestBytes, privateKey).toString("base64");
  const incompatibleResult = await updater.checkForUpdate();
  assert.match(incompatibleResult.error || "", /没有声明数据库向后兼容/u);

  manifestBytes = Buffer.from(JSON.stringify(manifest({ minimumVersion: "1.2.5" }), null, 2));
  signature = sign(null, manifestBytes, privateKey).toString("base64");
  const belowMinimum = await updater.checkForUpdate();
  assert.match(belowMinimum.error || "", /低于热更新最低版本/u);

  const unsafeAsset = manifest();
  unsafeAsset.releases["1.2.5"].windows.url = "http://downloads.example.com/goodjob.zip";
  manifestBytes = Buffer.from(JSON.stringify(unsafeAsset, null, 2));
  signature = sign(null, manifestBytes, privateKey).toString("base64");
  const unsafeAssetResult = await updater.checkForUpdate();
  assert.match(unsafeAssetResult.error || "", /必须使用 HTTPS/u);

  assert.throws(() => updater.setMirrorUrl("http://updates.example.com/goodjob"), /必须使用 HTTPS/u);
  if (process.platform !== "win32") {
    assert.deepEqual(await updater.applyUpdate(), { success: false, message: "一键热更新目前只在 Windows 便携版启用" });
  }

  console.log("auto updater tests passed");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(temporary, { recursive: true, force: true });
}

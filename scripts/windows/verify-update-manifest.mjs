import { readFileSync } from "node:fs";
import { verify } from "node:crypto";

const [manifestPath, signaturePath, publicKeyPath] = process.argv.slice(2);
if (!manifestPath || !signaturePath || !publicKeyPath) {
  console.error("Usage: verify-update-manifest.mjs <manifest.json> <manifest.sig> <public-key.pem>");
  process.exit(2);
}

try {
  const manifest = readFileSync(manifestPath);
  const signatureText = readFileSync(signaturePath, "utf8").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(signatureText)) throw new Error("manifest.sig 不是有效 Base64");
  const signature = Buffer.from(signatureText, "base64");
  const publicKey = readFileSync(publicKeyPath, "utf8");
  if (!verify(null, manifest, publicKey, signature)) throw new Error("manifest.json 签名无效");
  const parsed = JSON.parse(manifest.toString("utf8"));
  process.stdout.write(JSON.stringify({ ok: true, latestVersion: parsed.latestVersion }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

import assert from "node:assert/strict";
import { platformMfaTestHelpers } from "./platform-mfa.js";

process.env.PLATFORM_MFA_ENCRYPTION_KEY = "test-platform-mfa-key-with-at-least-32-characters";

const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const step = Math.floor(Date.now() / 30_000);
const code = platformMfaTestHelpers.totp(secret, step);
assert.equal(platformMfaTestHelpers.matches(secret, code), step);
assert.equal(platformMfaTestHelpers.matches(secret, code, step), null);

const encrypted = platformMfaTestHelpers.protect(secret);
assert.notEqual(encrypted, secret);
assert.equal(platformMfaTestHelpers.reveal(encrypted), secret);
assert.equal(
  platformMfaTestHelpers.hashRecoveryCode("ABCD-1234"),
  platformMfaTestHelpers.hashRecoveryCode("abcd-1234")
);

console.log(JSON.stringify({ ok: true, totp: true, replayBlocked: true, encryptedStorage: true, recoveryCodeHashing: true }, null, 2));

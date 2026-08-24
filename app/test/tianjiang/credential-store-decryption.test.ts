import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CredentialDecryptionError,
  MemoryCredentialStore,
  ScopedCredentialStore,
  unreadableBackupKey,
} from "../../src/tianjiang/crypto/credential-store";

const isolationRoot = path.resolve(
  process.cwd(),
  "..",
  ".local",
  "profile",
  "safe-storage-recovery-tests",
);

test("CredentialDecryptionError 只携带类别与内部键名，消息为安全中文", () => {
  const error = new CredentialDecryptionError("decrypt_failed", "auth:active-username");
  assert.equal(error.code, "CREDENTIAL_DECRYPTION_FAILED");
  assert.equal(error.category, "decrypt_failed");
  assert.equal(error.keyName, "auth:active-username");
  assert.match(error.message, /本地凭据解密失败/);
  assert.doesNotMatch(error.message, /decryptString|safeStorage|Error while/i);
  assert.equal(JSON.stringify(error).includes("decryptString"), false);
});

test("MemoryCredentialStore 不可读标记抛类型化错误且备份幂等", () => {
  const store = new MemoryCredentialStore();
  store.set("auth:active-username", "alice");
  store.markUndecryptable("auth:active-username");
  assert.throws(
    () => store.get("auth:active-username"),
    (error: unknown) => {
      assert.ok(error instanceof CredentialDecryptionError);
      assert.equal(error.keyName, "auth:active-username");
      assert.doesNotMatch(error.message, /decryptString/i);
      return true;
    },
  );
  assert.equal(store.backupUnreadableCiphertext("auth:active-username"), true);
  assert.equal(store.has(unreadableBackupKey("auth:active-username")), true);
  // 幂等：再次备份不覆盖
  const first = store.getCiphertext(unreadableBackupKey("auth:active-username"));
  assert.equal(store.backupUnreadableCiphertext("auth:active-username"), true);
  assert.equal(store.getCiphertext(unreadableBackupKey("auth:active-username")), first);
  // 不得静默删除原键
  assert.equal(store.has("auth:active-username"), true);
});

test("ScopedCredentialStore 跨 scope 稳定复现解密失败（模拟 dev Electron vs 打包 EXE）", () => {
  fs.mkdirSync(isolationRoot, { recursive: true });
  const file = path.join(isolationRoot, "secure-credentials-cross-runtime.json");
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // ignore
  }

  const dev = new ScopedCredentialStore(file, "dev-electron");
  dev.set("auth:active-username", "alice");
  dev.set("profile-key:018f3d6e-2d9e-7b6c-8a9b-1234567890ab", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

  // 同一文件、打包 scope 必须解密失败
  const packaged = new ScopedCredentialStore(file, "packaged-exe");
  assert.throws(
    () => packaged.get("auth:active-username"),
    (error: unknown) => {
      assert.ok(error instanceof CredentialDecryptionError);
      assert.equal(error.keyName, "auth:active-username");
      return true;
    },
  );
  // 原密文仍在磁盘，未被删除
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
  assert.ok(raw["auth:active-username"]);
  assert.equal(Object.keys(raw).some((k) => k.startsWith("device-recovery")), false);
});

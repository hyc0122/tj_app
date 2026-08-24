import assert from "node:assert/strict";
import test from "node:test";

import { safeLoginSyncInitMessage } from "../../src/routes/tianjiang/auth/login";
import { CredentialDecryptionError } from "../../src/tianjiang/crypto/credential-store";
import { PROFILE_KEY_RECOVERY_FAILED_MESSAGE } from "../../src/tianjiang/crypto/user-key-recovery";

test("登录路由同步错误脱敏：不回显 safeStorage 英文", () => {
  const raw = new Error(
    "Error while decrypting the ciphertext provided to safeStorage.decryptString.",
  );
  const message = safeLoginSyncInitMessage(raw);
  assert.doesNotMatch(message, /decryptString|safeStorage|ciphertext/i);
  assert.match(message, /登录后同步初始化失败|重试登录/);

  const typed = new CredentialDecryptionError("decrypt_failed", "auth:active-username");
  const typedMsg = safeLoginSyncInitMessage(typed);
  assert.match(typedMsg, /不兼容|重新登录|恢复/);
  assert.doesNotMatch(typedMsg, /decryptString/i);
  // 不得把内部键名当作用户文案泄露路径类信息以外的实现细节过多——允许中文
  assert.doesNotMatch(typedMsg, /auth:active-username/);

  assert.equal(
    safeLoginSyncInitMessage(new Error(PROFILE_KEY_RECOVERY_FAILED_MESSAGE)),
    PROFILE_KEY_RECOVERY_FAILED_MESSAGE,
  );
});

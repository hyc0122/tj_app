import assert from "node:assert/strict";
import test from "node:test";

test("只有平台不兼容才能建议 WSL，网络/登录/校验失败不得建议", async () => {
  const { classifyDreaminaNativeFailure } = await import(
    "../../src/tianjiang/model-providers/dreamina-cli/wsl-manager"
  );
  assert.equal(classifyDreaminaNativeFailure({ kind: "network", message: "ETIMEDOUT" }).class, "network");
  assert.equal(classifyDreaminaNativeFailure({ kind: "network", message: "ETIMEDOUT" }).suggestWsl, false);
  assert.equal(classifyDreaminaNativeFailure({ kind: "authentication", message: "login failed" }).suggestWsl, false);
  assert.equal(classifyDreaminaNativeFailure({ kind: "account", message: "user_credit failed" }).suggestWsl, false);
  assert.equal(classifyDreaminaNativeFailure({ kind: "arguments", message: "bad args" }).suggestWsl, false);
  assert.equal(classifyDreaminaNativeFailure({ kind: "integrity", message: "checksum mismatch" }).suggestWsl, false);
  const incompatible = classifyDreaminaNativeFailure({
    kind: "platform",
    message: "not a valid Win32 application",
    peMachine: 0x14c,
  });
  assert.equal(incompatible.class, "platform_incompatible");
  assert.equal(incompatible.suggestWsl, true);
});

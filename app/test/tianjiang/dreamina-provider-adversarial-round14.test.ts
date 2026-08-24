import assert from "node:assert/strict";
import test from "node:test";

import { classifyDreaminaNativeFailure } from "../../src/tianjiang/model-providers/dreamina-cli/wsl-manager";
import { resolveDreaminaExternalTarget } from "../../src/tianjiang/model-providers/dreamina-cli/external-link-policy";

test("对抗矩阵：恶意授权主机拒绝，非平台失败零 WSL", () => {
  const rejected = resolveDreaminaExternalTarget({
    kind: "authorization",
    url: "https://evil.example/login?device_code=secret",
  });
  assert.equal(rejected.ok, false);
  assert.doesNotMatch(JSON.stringify(rejected), /device_code=secret/);

  assert.equal(classifyDreaminaNativeFailure({ kind: "integrity", message: "checksum" }).suggestWsl, false);
  assert.equal(classifyDreaminaNativeFailure({ kind: "network", message: "timeout" }).suggestWsl, false);
  assert.equal(classifyDreaminaNativeFailure({ kind: "authentication", message: "oauth" }).suggestWsl, false);
  assert.equal(
    classifyDreaminaNativeFailure({ kind: "platform", peMachine: 0x14c, message: "win32" }).suggestWsl,
    true,
  );
});

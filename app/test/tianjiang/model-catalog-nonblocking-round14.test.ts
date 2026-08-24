import assert from "node:assert/strict";
import test from "node:test";

import { listNativeDreaminaModels } from "../../src/tianjiang/model-providers/native-provider-registry";

test("未探测即梦时目录必须立即返回 disabled 静态项且不得阻塞", async () => {
  const started = Date.now();
  const items = await listNativeDreaminaModels("image");
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 250, `模型目录被 CLI 探测阻塞 ${elapsed}ms`);
  assert.ok(items.length >= 1, "必须返回静态即梦图片模型");
  assert.ok(items.every((item) => item.disabled !== true), "未检测 CLI 时即梦模型必须仍可选择");
  assert.equal(
    items.some((item) => String(item.disabledReason ?? "").includes("尚未检测即梦 CLI")),
    false,
  );
  assert.ok(elapsed < 250, `模型目录被 CLI 探测阻塞 ${elapsed}ms`);
});

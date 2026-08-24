import assert from "node:assert/strict";
import test from "node:test";

import { buildAcceptanceRuntimeSnapshot } from "../../scripts/acceptance-runtime";

test("验收运行时只在显式模式返回实际 userData 与托盘对象状态", () => {
  assert.deepEqual(buildAcceptanceRuntimeSnapshot({
    acceptanceMode: true,
    userData: "E:\\worktree\\.local\\profile\\beta-upgrade-1",
    trayReady: true,
  }), {
    acceptanceMode: true,
    userData: "E:\\worktree\\.local\\profile\\beta-upgrade-1",
    trayReady: true,
  });
  assert.throws(
    () => buildAcceptanceRuntimeSnapshot({
      acceptanceMode: false,
      userData: "C:\\Users\\real-user",
      trayReady: true,
    }),
    /验收模式/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { PERSONAL_CLOSE_PENDING_MESSAGE } from "../../src/tianjiang/sync/personal-close-coordinator";

test("退出登录同步门文案不得承诺下次启动继续作为正常成功", () => {
  // 中文注释：正常退出路径 requireCentralSuccess 后不再把 pending 文案当成功。
  assert.match(PERSONAL_CLOSE_PENDING_MESSAGE, /下次启动/);
  // 失败阻断文案必须明确取消
  const cancelled = "中央同步未成功，已取消关闭/退出/切换账号";
  assert.match(cancelled, /取消/);
  assert.doesNotMatch(cancelled, /已同步/);
});

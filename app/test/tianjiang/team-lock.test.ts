import assert from "node:assert/strict";
import test from "node:test";

import { TeamLockGuard } from "../../src/tianjiang/sync/team-lock";

test("团队锁心跳或网络失效后立即切换只读并保留恢复原因", () => {
  const guard = new TeamLockGuard();
  guard.activate({ lockId: "lock-1", fencingToken: 9, expiresAt: Date.now() + 45_000 });
  assert.equal(guard.snapshot().editable, true);

  guard.onNetworkLost("network_disconnected");
  assert.deepEqual(guard.snapshot(), {
    editable: false,
    lockId: "",
    fencingToken: 0,
    readonlyReason: "network_disconnected",
    recoveryRequired: true,
  });
});

test("过期租约与不匹配的栅栏令牌不能提交", () => {
  const guard = new TeamLockGuard(() => 1_000);
  guard.activate({ lockId: "lock-1", fencingToken: 9, expiresAt: 900 });
  assert.equal(guard.canSubmit("lock-1", 9), false);
  guard.activate({ lockId: "lock-2", fencingToken: 10, expiresAt: 2_000 });
  assert.equal(guard.canSubmit("lock-2", 9), false);
  assert.equal(guard.canSubmit("lock-2", 10), true);
});

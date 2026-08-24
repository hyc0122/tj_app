import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const readAppSource = (relativePath: string): string =>
  fs.readFileSync(path.resolve("src", ...relativePath.split("/")), "utf8");

test("读取队列状态会自动恢复异常退出遗留的生命周期暂停，但不会绕过手动暂停", () => {
  const recoverySource = readAppSource(
    "tianjiang/model-providers/dreamina-cli/recovery.ts",
  );
  const routeSource = readAppSource("routes/task/dreaminaQueue/getState.ts");

  assert.match(
    recoverySource,
    /export\s+async\s+function\s+recoverOrphanedDreaminaLifecycleDrain/,
  );
  assert.match(routeSource, /recoverOrphanedDreaminaLifecycleDrain/);
  assert.match(routeSource, /enabledOnly:\s*true/);
  assert.match(routeSource, /wakeDreaminaScheduler/);
  assert.match(routeSource, /DREAMINA_QUEUE_STATE_FAILED/);
  assert.doesNotMatch(routeSource, /err\s+instanceof\s+Error\s*\?\s*err\.message/);
});

test("任务中心只展示安全阶段与稳定错误原因，不读取供应商原始错误摘要", async () => {
  const aggregation = await import(
    "../../src/tianjiang/tasks/task-center-aggregation"
  );
  const source = readAppSource("tianjiang/tasks/task-center-aggregation.ts");

  assert.equal(
    aggregation.describeStoryboardTaskCenterReason("submitted", null, false),
    "远端任务已提交，正在按设置的轮询间隔查询",
  );
  assert.equal(
    aggregation.describeStoryboardTaskCenterReason(
      "cancelled_local",
      null,
      false,
    ),
    "任务已在本机取消；远端任务可能仍需单独确认",
  );
  assert.equal(
    aggregation.describeStoryboardTaskCenterReason(
      "failed",
      "DREAMINA_CLI_NOT_LOGGED_IN",
      false,
    ),
    "即梦 CLI 未登录",
  );
  assert.equal(
    aggregation.describeStoryboardTaskCenterReason("completed", null, false),
    "即梦 CLI 生成完成，结果已回写",
  );
  assert.match(source, /errorCode/);
  assert.doesNotMatch(source, /errorSummary/);
});

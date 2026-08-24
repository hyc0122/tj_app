import assert from "node:assert/strict";
import test from "node:test";

import {
  isLegacyProjectMutation,
  isLegacyProjectRoute,
} from "../../src/tianjiang/runtime/legacy-project-guard";

const TASK_READS = [
  "/api/task/getTaskApi",
  "/api/task/getTaskCategories",
  "/api/task/getProject",
] as const;

test("任务中心三个读取 POST 登记为只读且不进入单项目授权门", () => {
  for (const pathname of TASK_READS) {
    assert.equal(
      isLegacyProjectMutation("POST", pathname),
      false,
      `${pathname} 不得再被当成写操作`,
    );
    assert.equal(
      isLegacyProjectRoute(pathname),
      false,
      `${pathname} 应账号级聚合，跳过单项目中间件`,
    );
  }
});

test("任务写路由仍受项目写门保护", () => {
  assert.equal(isLegacyProjectMutation("POST", "/api/task/retryRemoteTask"), true);
  assert.equal(isLegacyProjectRoute("/api/task/retryRemoteTask"), true);
  assert.equal(isLegacyProjectMutation("POST", "/api/task/taskDetails"), true);
});

test("无活动项目时读取任务中心不再要求写锁语义", () => {
  // mutation=false 时前端 assertLegacyProjectWriteAllowed 直接放行
  for (const pathname of TASK_READS) {
    assert.equal(isLegacyProjectMutation("POST", pathname), false);
  }
});

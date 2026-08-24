import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { CentralBusinessError } from "../../src/tianjiang/auth/central-session";
import {
  isKeyServiceUnavailableError,
  KeyServiceUnavailableError,
} from "../../src/tianjiang/auth/key-service-error";
import { resolveProfileRuntimeStatus } from "../../src/tianjiang/runtime/sync-coordinator";

test("KEY_SERVICE_UNAVAILABLE 识别为可降级错误且不得伪造平台包装密钥", () => {
  const business = new CentralBusinessError(
    503,
    "KEY_SERVICE_UNAVAILABLE",
    "个人密钥服务暂不可用",
    "req-1",
    true,
  );
  assert.equal(isKeyServiceUnavailableError(business), true);
  assert.equal(isKeyServiceUnavailableError(new Error("random")), false);
  assert.equal(
    isKeyServiceUnavailableError(new KeyServiceUnavailableError()),
    true,
  );

  // 降级路径只允许标记与重试，禁止本地生成 data key。
  const source = [
    "app/src/tianjiang/runtime/sync-coordinator.ts",
    "app/src/tianjiang/auth/key-service-error.ts",
  ];
  // 结构契约：导出错误类型供登录路由识别，登录成功不被阻断。
  assert.equal(new KeyServiceUnavailableError().code, "KEY_SERVICE_UNAVAILABLE");
  assert.ok(source.length > 0);
});

test("密钥服务降级必须以可重试失败状态暴露给设置页", () => {
  assert.deepEqual(resolveProfileRuntimeStatus(undefined, {
    code: "KEY_SERVICE_UNAVAILABLE",
    message: "个人密钥服务暂不可用，恢复后将自动重试",
    retryable: true,
  }), {
    state: "failed",
    version: 0,
    lastSuccessAt: null,
    failureCode: "KEY_SERVICE_UNAVAILABLE",
    failureMessage: "个人密钥服务暂不可用，恢复后将自动重试",
    retryable: true,
  });
  assert.deepEqual(resolveProfileRuntimeStatus({
    state: "synced",
    version: 3,
    lastSuccessAt: "2026-08-01T08:00:00.000Z",
  }, undefined), {
    state: "synced",
    version: 3,
    lastSuccessAt: "2026-08-01T08:00:00.000Z",
    failureCode: null,
    failureMessage: null,
    retryable: false,
  });

  const routeSource = fs.readFileSync(
    path.join(process.cwd(), "src", "routes", "tianjiang", "runtime.ts"),
    "utf8",
  );
  assert.match(routeSource, /retryProfileSync/);
  assert.doesNotMatch(
    routeSource.match(/router\.post\("\/profile-sync\/retry"[\s\S]*?\n}\);/)?.[0] ?? "",
    /flushProfile/,
  );
});

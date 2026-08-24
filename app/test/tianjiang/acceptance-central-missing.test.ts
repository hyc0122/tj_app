import assert from "node:assert/strict";
import test from "node:test";

test("验收模式缺少 loopback 中央 URL 时导入认证运行时即失败关闭", async () => {
  process.env.TIANJIANG_ACCEPTANCE_MODE = "1";
  delete process.env.TIANJIANG_ACCEPTANCE_CENTRAL_API_URL;
  await assert.rejects(
    () => import("../../src/tianjiang/auth/auth-runtime"),
    /验收.*中央.*(?:URL|地址)/i,
  );
});

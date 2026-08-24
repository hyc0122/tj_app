import assert from "node:assert/strict";
import test from "node:test";

test("验收模式拒绝远程或非 HTTP 中央 URL 并在网络前失败关闭", async () => {
  process.env.TIANJIANG_ACCEPTANCE_MODE = "1";
  process.env.TIANJIANG_ACCEPTANCE_CENTRAL_API_URL = "https://api.j11.com.cn/admin/api";
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error("不应发起网络请求");
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => import("../../src/tianjiang/auth/auth-runtime"),
      /验收.*中央.*(?:URL|地址)/i,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import assert from "node:assert/strict";
import test from "node:test";

test("正常生产忽略验收中央 URL 并继续使用固定 HTTPS", async () => {
  const originalFetch = globalThis.fetch;
  const originalMode = process.env.TIANJIANG_ACCEPTANCE_MODE;
  const originalCentralURL = process.env.TIANJIANG_ACCEPTANCE_CENTRAL_API_URL;
  const calls: string[] = [];
  delete process.env.TIANJIANG_ACCEPTANCE_MODE;
  process.env.TIANJIANG_ACCEPTANCE_CENTRAL_API_URL = "http://127.0.0.1:18080";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({
      code: 0,
      data: {
        captchaId: "production-fixed-url",
        picPath: "data:image/png;base64,AA",
        openCaptcha: true,
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const { centralAuthGateway } = await import("../../src/tianjiang/auth/auth-runtime");
    await centralAuthGateway.captcha();
    assert.deepEqual(calls, [
      "https://api.j11.com.cn/api/tianjiang/v1/auth/captcha",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("TIANJIANG_ACCEPTANCE_MODE", originalMode);
    restoreEnvironment("TIANJIANG_ACCEPTANCE_CENTRAL_API_URL", originalCentralURL);
  }
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

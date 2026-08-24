import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";

/**
 * 使用 Node http.request 访问 listen(0) 分配的动态端口，避免 Fetch 禁止端口列表造成随机失败。
 * 返回标准 Response，确保产品代码仍按真实 fetch 响应读取状态、响应头和 JSON。
 */
function nodeHttpFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  const requestHeaders = Object.fromEntries(new Headers(init.headers).entries());

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers: requestHeaders,
        signal: init.signal ?? undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(name, item);
            } else if (value !== undefined) {
              responseHeaders.set(name, value);
            }
          }
          resolve(new Response(Buffer.concat(chunks), {
            status: response.statusCode ?? 500,
            statusText: response.statusMessage,
            headers: responseHeaders,
          }));
        });
      },
    );
    request.on("error", reject);
    if (typeof init.body === "string" || Buffer.isBuffer(init.body)) {
      request.write(init.body);
    }
    request.end();
  });
}

test("验收模式验证码只能到显式 loopback stub 并记录真实 HTTP 请求", async () => {
  const originalFetch = globalThis.fetch;
  const originalMode = process.env.TIANJIANG_ACCEPTANCE_MODE;
  const originalCentralURL = process.env.TIANJIANG_ACCEPTANCE_CENTRAL_API_URL;
  const stubRequests: Array<{ method: string; url: string }> = [];
  const guardedFetchCalls: string[] = [];

  const stub = http.createServer((request, response) => {
    stubRequests.push({
      method: request.method ?? "",
      url: request.url ?? "",
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      code: 0,
      data: {
        captchaId: "acceptance-stub-id",
        picPath: "data:image/png;base64,AA",
        openCaptcha: true,
      },
    }));
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  const stubPort = (stub.address() as AddressInfo).port;

  process.env.TIANJIANG_ACCEPTANCE_MODE = "1";
  process.env.TIANJIANG_ACCEPTANCE_CENTRAL_API_URL = `http://127.0.0.1:${stubPort}`;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    guardedFetchCalls.push(url.toString());
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== String(stubPort)) {
      throw new Error(`测试网络门禁拒绝非 loopback 请求：${url.origin}`);
    }
    // 产品验证码请求仍先经过 loopback 门禁，仅替换门禁后的测试传输实现。
    return nodeHttpFetch(input, init);
  }) as typeof fetch;

  let localServer: http.Server | undefined;
  try {
    const { default: captchaRouter } = await import("../../src/routes/tianjiang/auth/captcha");
    const app = express();
    app.use(express.json());
    app.use("/captcha", captchaRouter);
    localServer = app.listen(0, "127.0.0.1");
    await once(localServer, "listening");
    const localPort = (localServer.address() as AddressInfo).port;

    const response = await nodeHttpFetch(`http://127.0.0.1:${localPort}/captcha`, {
      method: "POST",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      code: 0,
      data: {
        captchaId: "acceptance-stub-id",
        picPath: "data:image/png;base64,AA",
        openCaptcha: true,
      },
      message: "验证码获取成功",
    });
    assert.deepEqual(stubRequests, [{
      method: "POST",
      url: "/api/tianjiang/v1/auth/captcha",
    }]);
    assert.deepEqual(guardedFetchCalls, [
      `http://127.0.0.1:${stubPort}/api/tianjiang/v1/auth/captcha`,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("TIANJIANG_ACCEPTANCE_MODE", originalMode);
    restoreEnvironment("TIANJIANG_ACCEPTANCE_CENTRAL_API_URL", originalCentralURL);
    if (localServer) {
      await new Promise<void>((resolve, reject) =>
        localServer!.close((error) => error ? reject(error) : resolve()));
    }
    await new Promise<void>((resolve, reject) =>
      stub.close((error) => error ? reject(error) : resolve()));
  }
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

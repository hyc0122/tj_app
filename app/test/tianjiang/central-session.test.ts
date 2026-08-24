import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import express, { type Router } from "express";

import captchaRouter from "../../src/routes/tianjiang/auth/captcha";
import loginRouter from "../../src/routes/tianjiang/auth/login";
import registerRouter from "../../src/routes/tianjiang/auth/register";
import { centralAuthGateway } from "../../src/tianjiang/auth/auth-runtime";
import {
  CENTRAL_API_URL,
  CentralAuthGateway,
  MemoryCentralSessionStore,
  buildSessionCookie,
  clearSessionCookie,
  createTestOnlyLoopbackPolicy,
  mapCentralError,
  normalizeServerUrl,
} from "../../src/tianjiang/auth/central-session";
import {
  CENTRAL_API_UNREACHABLE,
  CentralServiceUnavailableError,
  centralServiceUnavailableResponse,
} from "../../src/tianjiang/auth/central-service-error";

test("中央 JWT 只保存在内存会话，Cookie 使用不透明随机 ID", () => {
  const store = new MemoryCentralSessionStore();
  const session = store.create({
    serverUrl: CENTRAL_API_URL,
    token: "central-jwt-secret",
    expiresAt: Date.now() + 60_000,
    user: { id: 7, username: "alice", nickname: "Alice" },
  });
  assert.notEqual(session.id, "central-jwt-secret");
  assert.equal(store.get(session.id)?.token, "central-jwt-secret");

  const cookie = buildSessionCookie(session.id, false, 60);
  assert.match(cookie, /^tj_session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Path=\/api/i);
  assert.doesNotMatch(cookie, /central-jwt-secret/);
  assert.match(clearSessionCookie(false), /Max-Age=0/);
});

test("验证码、注册和登录只请求固定天将业务认证地址", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const gateway = new CentralAuthGateway(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    if (url.endsWith("/captcha")) {
      return jsonResponse({
        code: 0,
        data: { captchaId: "captcha-id", picPath: "data:image/png;base64,AA", openCaptcha: true },
      });
    }
    if (url.endsWith("/register")) {
      return jsonResponse({ code: 0, data: {}, msg: "注册申请已受理，请返回登录" });
    }
    return jsonResponse({
      code: 0,
      data: {
        token: "business-jwt",
        expiresAt: Date.now() + 60_000,
        user: { id: 7, username: "alice", nickname: "Alice" },
      },
    });
  });

  await gateway.captcha();
  await gateway.register({
    username: "alice",
    nickname: "Alice",
    password: "SecurePass123!",
    captcha: "123456",
    captchaId: "captcha-id",
  });
  const result = await gateway.login({
    username: "alice",
    password: "SecurePass123!",
    captcha: "123456",
    captchaId: "captcha-id-2",
    serverUrl: "https://attacker.invalid",
  } as any);

  assert.deepEqual(calls.map(({ url }) => url), [
    `${CENTRAL_API_URL}/api/tianjiang/v1/auth/captcha`,
    `${CENTRAL_API_URL}/api/tianjiang/v1/auth/register`,
    `${CENTRAL_API_URL}/api/tianjiang/v1/auth/login`,
  ]);
  assert.equal(calls.some(({ body }) => "serverUrl" in body), false);
  assert.equal(result.session.serverUrl, CENTRAL_API_URL);
  assert.deepEqual(result.publicUser, {
    id: 7,
    username: "alice",
    nickname: "Alice",
  });
  assert.equal("token" in result.publicUser, false);
});

test("中央会话复核使用业务 session 接口，退出只销毁本地会话", async () => {
  const calls: string[] = [];
  const gateway = new CentralAuthGateway(async (input) => {
    calls.push(String(input));
    return jsonResponse({
      code: 0,
      data: { userId: 7, username: "alice" },
    });
  });
  const store = new MemoryCentralSessionStore();
  const session = store.create({
    serverUrl: CENTRAL_API_URL,
    token: "business-jwt",
    expiresAt: Date.now() + 60_000,
    user: { id: 7, username: "alice", nickname: "Alice" },
  });

  await gateway.validate(session);
  await gateway.logout(session);
  assert.deepEqual(calls, [`${CENTRAL_API_URL}/api/tianjiang/v1/session`]);
});

test("中央 API 网络失败必须与认证失败和本地服务失败分开", async () => {
  const gateway = new CentralAuthGateway(async () => {
    throw Object.assign(new Error("connect ETIMEDOUT 203.0.113.7:443"), {
      code: "ETIMEDOUT",
    });
  });

  await assert.rejects(
    () => gateway.captcha(),
    (error: unknown) => (
      error instanceof CentralServiceUnavailableError
      && error.code === CENTRAL_API_UNREACHABLE
      && /中央 API 不可达/.test(error.message)
    ),
  );

  const response = centralServiceUnavailableResponse(
    new CentralServiceUnavailableError(new Error("fetch failed")),
  );
  assert.deepEqual(response, {
    status: 503,
    body: {
      code: CENTRAL_API_UNREACHABLE,
      message: "中央 API 不可达，请检查网络连接或稍后重试。",
    },
  });
  assert.equal(centralServiceUnavailableResponse(new Error("密码错误")), null);
});

test("中央 HTTP 状态纯映射不依赖 Gateway 或路由副作用", () => {
  assert.deepEqual(mapCentralError({ status: 404 }), {
    status: 503,
    code: "CENTRAL_AUTH_NOT_READY",
    message: "中央认证服务尚未就绪，请稍后重试。",
  });
  for (const status of [500, 502, 503]) {
    assert.deepEqual(mapCentralError({ status }), {
      status: 503,
      code: "CENTRAL_AUTH_UNAVAILABLE",
      message: "中央认证服务暂时不可用，请稍后重试。",
    });
  }
  assert.equal(mapCentralError({ status: 400 }), null);
  assert.equal(mapCentralError({ status: 401 }), null);
});

test("验证码路由在中央网络失败时返回独立 503", async () => {
  await assertAuthRouteUnavailable(captchaRouter, "captcha", {});
});

test("登录路由在中央网络失败时返回独立 503", async () => {
  await assertAuthRouteUnavailable(loginRouter, "login", {
    username: "alice",
    password: "SecurePass123!",
    captcha: "123456",
    captchaId: "captcha-id",
  });
});

test("注册路由在中央网络失败时返回独立 503", async () => {
  await assertAuthRouteUnavailable(registerRouter, "register", {
    username: "alice",
    nickname: "Alice",
    password: "SecurePass123!",
    captcha: "123456",
    captchaId: "captcha-id",
  });
});

test("中央认证 404/5xx 经真实 Gateway 贯穿验证码、登录和注册为服务状态", async () => {
  const routeCases = [
    { router: captchaRouter, gatewayMethod: "captcha" as const, body: {} },
    {
      router: loginRouter,
      gatewayMethod: "login" as const,
      body: {
        username: "alice",
        password: "SecurePass123!",
        captcha: "123456",
        captchaId: "captcha-id",
      },
    },
    {
      router: registerRouter,
      gatewayMethod: "register" as const,
      body: {
        username: "alice",
        nickname: "Alice",
        password: "SecurePass123!",
        captcha: "123456",
        captchaId: "captcha-id",
      },
    },
  ];

  for (const upstream of [
    {
      status: 404,
      code: "CENTRAL_AUTH_NOT_READY",
      message: "中央认证服务尚未就绪，请稍后重试。",
    },
    ...[500, 502, 503].map((status) => ({
      status,
      code: "CENTRAL_AUTH_UNAVAILABLE",
      message: "中央认证服务暂时不可用，请稍后重试。",
    })),
  ]) {
    const gateway = new CentralAuthGateway(async () => centralErrorResponse(upstream.status));
    let gatewayError: unknown;
    try {
      await gateway.captcha();
    } catch (error) {
      gatewayError = error;
    }
    assert.deepEqual(centralServiceUnavailableResponse(gatewayError), {
      status: 503,
      body: {
        code: upstream.code,
        message: upstream.message,
      },
    });

    for (const routeCase of routeCases) {
      await assertAuthRouteCentralStatus(
        routeCase.router,
        routeCase.gatewayMethod,
        routeCase.body,
        upstream,
      );
    }
  }
});

test("普通中央业务错误不被误分类为服务未就绪或不可用", async () => {
  await assertAuthRouteBusinessError(registerRouter, {
    upstreamStatus: 400,
    body: {
      username: "alice",
      nickname: "Alice",
      password: "SecurePass123!",
      captcha: "wrong",
      captchaId: "captcha-id",
    },
    expectedStatus: 400,
    expectedBody: {
      code: 400,
      message: "注册申请未受理，请检查填写内容",
    },
  });
  await assertAuthRouteBusinessError(loginRouter, {
    upstreamStatus: 401,
    body: {
      username: "alice",
      password: "WrongPass123!",
      captcha: "123456",
      captchaId: "captcha-id",
    },
    expectedStatus: 401,
    expectedBody: {
      code: 401,
      message: "中央认证失败",
    },
  });
});

test("控制面转发只允许天将漫创业务路径，并由服务端注入业务令牌", async () => {
  const calls: Array<{ url: string; token: string }> = [];
  const gateway = new CentralAuthGateway(async (input, init) => {
    calls.push({
      url: String(input),
      token: String(new Headers(init?.headers).get("x-token") ?? ""),
    });
    return jsonResponse({ code: 0, data: [{ teamUuid: "team-1" }] });
  });
  const session = {
    id: "opaque-session",
    serverUrl: CENTRAL_API_URL,
    token: "business-jwt",
    expiresAt: Date.now() + 60_000,
    user: { id: 7, username: "alice", nickname: "Alice" },
    validatedAt: Date.now(),
  };

  const data = await gateway.forwardBusinessRequest(session, "/api/tianjiang/v1/teams", "GET");
  assert.deepEqual(data, [{ teamUuid: "team-1" }]);
  assert.deepEqual(calls, [{
    url: `${CENTRAL_API_URL}/api/tianjiang/v1/teams`,
    token: "business-jwt",
  }]);
  await assert.rejects(
    () => gateway.forwardBusinessRequest(session, "/admin/api/users", "GET"),
    /业务路径无效/,
  );
});

test("业务前端关键认证文件不得读写 JWT、刷新令牌或模型密钥到 localStorage", () => {
  const webRoot = path.resolve(__dirname, "../../../web");
  const files = [
    "src/utils/axios.ts",
    "src/stores/user.ts",
    "src/router/index.ts",
    "src/pages/login/index.vue",
    "src/utils/useSocket.ts",
    "src/utils/useChat.ts",
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(webRoot, file), "utf8");
    assert.doesNotMatch(
      source,
      /localStorage\.(?:getItem|setItem)\(\s*["'](?:token|refreshToken|modelKey)/,
    );
  }
});

test("生产固定 HTTPS；显式 test-only 策略仅允许 loopback 覆盖", () => {
  assert.equal(CENTRAL_API_URL, "https://api.j11.com.cn");
  assert.equal(normalizeServerUrl(CENTRAL_API_URL), CENTRAL_API_URL);
  assert.throws(() => normalizeServerUrl("http://central.example.invalid"), /中央服务地址无效/);

  for (const accepted of [
    "http://127.0.0.1:1",
    "http://127.0.0.1:80",
    "http://127.0.0.1:18080",
    "http://127.0.0.1:65535",
  ]) {
    const policy = createTestOnlyLoopbackPolicy(accepted);
    assert.equal(policy.serverUrl, accepted);
    assert.equal(normalizeServerUrl(accepted, policy), accepted);
  }
  for (const rejected of [
    "http://192.168.1.8:18080",
    "http://localhost:18080",
    "http://127.1:18080",
    "http://2130706433:18080",
    "http://0177.0.0.1:18080",
    "https://127.0.0.1:18080",
    "http://127.0.0.1",
    "http://127.0.0.1:0",
    "http://127.0.0.1:080",
    "http://127.0.0.1:018080",
    "http://127.0.0.1:65536",
    "HTTP://127.0.0.1:18080",
    " http://127.0.0.1:18080",
    "http://127.0.0.1:18080 ",
    "http://user@127.0.0.1:18080",
    "http://user:pass@127.0.0.1:18080",
    "http://127.0.0.1:18080/",
    "http://127.0.0.1:18080/admin/api",
    "http://127.0.0.1:18080/api",
    "http://127.0.0.1:18080?target=/admin/api",
    "http://127.0.0.1:18080#admin",
  ]) {
    assert.throws(
      () => createTestOnlyLoopbackPolicy(rejected),
      /测试中央服务地址无效/,
      `必须拒绝：${rejected}`,
    );
  }
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function centralErrorResponse(status: number): Response {
  return new Response(JSON.stringify({
    code: status,
    msg: status === 404
      ? "Not Found"
      : status >= 500
        ? "Service Unavailable"
        : "Business Error",
  }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function assertAuthRouteUnavailable(
  router: Router,
  gatewayMethod: "captcha" | "login" | "register",
  body: Record<string, unknown>,
): Promise<void> {
  const mutableGateway = centralAuthGateway as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const originalMethod = mutableGateway[gatewayMethod];
  mutableGateway[gatewayMethod] = async () => {
    throw new CentralServiceUnavailableError(new Error("fetch failed"));
  };

  const app = express();
  app.use(express.json());
  app.use("/", router);
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      code: CENTRAL_API_UNREACHABLE,
      message: "中央 API 不可达，请检查网络连接或稍后重试。",
    });
  } finally {
    // 单例方法必须恢复，避免本文件后续认证测试继承网络故障桩。
    mutableGateway[gatewayMethod] = originalMethod;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function assertAuthRouteCentralStatus(
  router: Router,
  gatewayMethod: "captcha" | "login" | "register",
  body: Record<string, unknown>,
  expected: {
    status: number;
    code: string;
    message: string;
  },
): Promise<void> {
  const mutableGateway = centralAuthGateway as unknown as {
    fetcher: typeof fetch;
  };
  const originalFetcher = mutableGateway.fetcher;
  mutableGateway.fetcher = async () => centralErrorResponse(expected.status);

  const app = express();
  app.use(express.json());
  app.use("/", router);
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(
      response.status,
      503,
      `${gatewayMethod} 应将中央 ${expected.status} 映射为本地 503`,
    );
    assert.deepEqual(await response.json(), {
      code: expected.code,
      message: expected.message,
    });
  } finally {
    mutableGateway.fetcher = originalFetcher;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function assertAuthRouteBusinessError(
  router: Router,
  expected: {
    upstreamStatus: number;
    body: Record<string, unknown>;
    expectedStatus: number;
    expectedBody: Record<string, unknown>;
  },
): Promise<void> {
  const mutableGateway = centralAuthGateway as unknown as {
    fetcher: typeof fetch;
  };
  const originalFetcher = mutableGateway.fetcher;
  mutableGateway.fetcher = async () => centralErrorResponse(expected.upstreamStatus);

  const app = express();
  app.use(express.json());
  app.use("/", router);
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(expected.body),
    });
    assert.equal(response.status, expected.expectedStatus);
    assert.deepEqual(await response.json(), expected.expectedBody);
  } finally {
    mutableGateway.fetcher = originalFetcher;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

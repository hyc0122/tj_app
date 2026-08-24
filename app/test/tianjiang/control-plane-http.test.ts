import assert from "node:assert/strict";
import http from "node:http";
import test, { after, before } from "node:test";
import express from "express";
import type { Router } from "express";
import type { MemoryCentralSessionStore } from "../../src/tianjiang/auth/central-session";

const upstreamCalls: Array<{
  method: string;
  url: string;
  token: string;
  requestId: string;
  body: unknown;
}> = [];

const originalFetch = globalThis.fetch;
const clientFetch = originalFetch;
let upstreamMode: "contract" | "non-json" | "throw" | "invalid-500" = "contract";
globalThis.fetch = async (input, init) => {
  upstreamCalls.push({
    method: String(init?.method ?? "GET"),
    url: String(input),
    token: new Headers(init?.headers).get("x-token") ?? "",
    requestId: new Headers(init?.headers).get("x-request-id") ?? "",
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  });
  if (upstreamMode === "throw") {
    throw new Error("fixture network failure");
  }
  if (upstreamMode === "non-json") {
    return new Response("bad gateway", {
      status: 502,
      headers: { "x-request-id": "request-from-upstream" },
    });
  }
  if (upstreamMode === "invalid-500") {
    return new Response(JSON.stringify({ message: "private upstream failure" }), {
      status: 500,
      headers: {
        "content-type": "application/json",
        "x-request-id": "request-from-upstream",
      },
    });
  }
  return new Response(JSON.stringify({
    code: "BASE_VERSION_STALE",
    data: null,
    msg: "基础版本已过期",
  }), {
    status: 409,
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-from-upstream",
    },
  });
};

let server: http.Server;
let baseURL = "";
let centralSessionStore: MemoryCentralSessionStore;
let controlPlaneRouter: Router;

before(async () => {
  ({ centralSessionStore } = await import("../../src/tianjiang/auth/auth-runtime"));
  controlPlaneRouter = (await import("../../src/routes/tianjiang/control-plane")).default;
  const session = centralSessionStore.create({
    serverUrl: "https://central.example.invalid",
    token: "server-side-central-token",
    expiresAt: Date.now() + 60_000,
    user: {
      id: 7,
      username: "owner",
      nickname: "Owner",
    },
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { centralSession: typeof session }).centralSession = session;
    next();
  });
  app.use("/api/tianjiang/v1", controlPlaneRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseURL = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test("Node 生产控制面保持版本化路径、JWT、请求 ID、409 与公共错误码", async () => {
  upstreamMode = "contract";
  const response = await clientFetch(`${baseURL}/api/tianjiang/v1/upload-sessions/session-1/commit`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-from-client",
    },
    body: JSON.stringify({ base_version: 8 }),
  });
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 409);
  assert.equal(response.headers.get("x-request-id"), "request-from-upstream");
  assert.deepEqual(body, {
    code: "BASE_VERSION_STALE",
    data: null,
    msg: "基础版本已过期",
  });
  assert.deepEqual(upstreamCalls, [{
    method: "POST",
    url: "https://central.example.invalid/api/tianjiang/v1/upload-sessions/session-1/commit",
    token: "server-side-central-token",
    requestId: "request-from-client",
    body: { base_version: 8 },
  }]);
});

for (const scenario of [
  { name: "网络异常", mode: "throw" as const, expectedRequestId: "request-network-failure" },
  { name: "非 JSON 上游", mode: "non-json" as const, expectedRequestId: "request-non-json" },
  { name: "非契约 5xx", mode: "invalid-500" as const, expectedRequestId: "request-from-upstream" },
]) {
  test(`Node 将${scenario.name}收敛为带追踪信息的公共错误`, async () => {
    upstreamMode = scenario.mode;
    const clientRequestId = scenario.mode === "non-json"
      ? "request-non-json"
      : scenario.mode === "throw"
        ? "request-network-failure"
        : "request-invalid-500";
    const response = await clientFetch(`${baseURL}/api/tianjiang/v1/session`, {
      headers: { "x-request-id": clientRequestId },
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-request-id"), scenario.expectedRequestId);
    assert.deepEqual(await response.json(), {
      code: "STORAGE_UNAVAILABLE",
      data: null,
      msg: "中央业务请求失败",
      request_id: scenario.expectedRequestId,
      retryable: true,
    });
  });
}

test("Node 不允许通过编码路径穿越访问契约外接口", async () => {
  upstreamMode = "contract";
  const beforeCalls = upstreamCalls.length;
  const response = await clientFetch(
    `${baseURL}/api/tianjiang/v1/projects/%252e%252e/storage-config`,
    { headers: { "x-request-id": "request-invalid-path" } },
  );
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-request-id"), "request-invalid-path");
  assert.deepEqual(body, {
    code: "PROJECT_NOT_FOUND",
    data: null,
    msg: "接口不存在",
    request_id: "request-invalid-path",
    retryable: false,
  });
  assert.equal(upstreamCalls.length, beforeCalls);
});

test("Node 只按新增白名单透传邀请待办、拒绝、用户名邀请与项目创建", async () => {
  upstreamMode = "contract";
  const beforeCalls = upstreamCalls.length;
  const requests = [
    {
      path: "/api/tianjiang/v1/team-invitations",
      method: "GET",
      expectedBody: undefined,
    },
    {
      path: "/api/tianjiang/v1/team-invitations/invitation-1/reject",
      method: "POST",
      body: {},
      expectedBody: undefined,
    },
    {
      path: "/api/tianjiang/v1/teams/team-1/invitations",
      method: "POST",
      body: { username: " Alice_01 ", role: "editor" },
      expectedBody: { username: "alice_01", role: "editor" },
    },
    {
      path: "/api/tianjiang/v1/projects",
      method: "POST",
      body: {
        name: "团队项目",
        scope: "team",
        teamUuid: "team-1",
        teamName: "不得透传",
        businessType: "novel",
      },
      expectedBody: {
        name: "团队项目",
        scope: "team",
        teamUuid: "team-1",
        businessType: "novel",
      },
    },
  ] as const;

  for (const request of requests) {
    const response = await clientFetch(`${baseURL}${request.path}`, {
      method: request.method,
      headers: {
        "content-type": "application/json",
        "x-request-id": `request-${beforeCalls}-${request.method}`,
      },
      body: "body" in request ? JSON.stringify(request.body) : undefined,
    });
    assert.equal(
      response.status,
      409,
      `${request.method} ${request.path}: ${await response.clone().text()}`,
    );
  }

  assert.deepEqual(
    upstreamCalls.slice(beforeCalls).map(({ method, url, body }) => ({ method, url, body })),
    requests.map((request) => ({
      method: request.method,
      url: `https://central.example.invalid${request.path}`,
      body: request.expectedBody,
    })),
  );

  const callsBeforeLegacyInvite = upstreamCalls.length;
  const legacyInvite = await clientFetch(`${baseURL}/api/tianjiang/v1/teams/team-1/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: 7, role: "editor" }),
  });
  assert.equal(legacyInvite.status, 422);
  assert.equal(upstreamCalls.length, callsBeforeLegacyInvite);
});

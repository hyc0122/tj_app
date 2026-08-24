import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";

import {
  CentralAuthGateway,
  MemoryCentralSessionStore,
} from "../../src/tianjiang/auth/central-session";
import { createCentralSessionMiddleware } from "../../src/tianjiang/auth/session-middleware";
import { createControlPlaneRouter } from "../../src/routes/tianjiang/control-plane";

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, port: address.port };
}

/**
 * 使用 Node http.request，避免 undici/fetch 禁止端口列表导致偶发 “bad port”。
 * 仍走真实 HTTP + 真实 Cookie，不改变中间件契约验证语义。
 */
function httpGetJson(
  port: number,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "GET",
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let body: unknown = raw;
          try {
            body = raw ? JSON.parse(raw) : null;
          } catch {
            body = raw;
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body,
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("生产会话中间件对无 Cookie 返回完整 AUTH_REQUIRED 契约", async (t) => {
  const sessions = new MemoryCentralSessionStore();
  const gateway = new CentralAuthGateway();
  const app = express();
  app.use(express.json());
  app.use(createCentralSessionMiddleware({
    gateway,
    sessionStore: sessions,
    onSessionInvalid: async () => {},
  }));
  app.use("/api/tianjiang/v1", createControlPlaneRouter(gateway, sessions));
  const { server, port } = await listen(app);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const response = await httpGetJson(port, "/api/tianjiang/v1/session", {
    "x-request-id": "task5-no-cookie",
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers["x-request-id"], "task5-no-cookie");
  assert.deepEqual(response.body, {
    code: "AUTH_REQUIRED",
    data: null,
    msg: "中央会话不存在或已过期",
    request_id: "task5-no-cookie",
    retryable: false,
  });
});

test("生产会话中间件通过真实 Cookie 解析会话且执行中央校验", async (t) => {
  const requestedPaths: string[] = [];
  const gateway = new CentralAuthGateway(async (input) => {
    requestedPaths.push(new URL(String(input)).pathname);
    return new Response(JSON.stringify({
      code: 0,
      data: { userId: 7, username: "owner" },
      msg: "ok",
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const sessions = new MemoryCentralSessionStore();
  const session = sessions.create({
    serverUrl: "https://central.example.invalid",
    token: "central-token",
    expiresAt: Date.now() + 60_000,
    user: { id: 7, username: "owner", nickname: "Owner" },
  });
  session.validatedAt = 0;

  const app = express();
  app.use(express.json());
  app.use(createCentralSessionMiddleware({
    gateway,
    sessionStore: sessions,
    onSessionInvalid: async () => {},
  }));
  app.use("/api/tianjiang/v1", createControlPlaneRouter(gateway, sessions));
  const { server, port } = await listen(app);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const response = await httpGetJson(port, "/api/tianjiang/v1/session", {
    cookie: `tj_session=${encodeURIComponent(session.id)}`,
    "x-request-id": "task5-cookie-session",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(requestedPaths, [
    "/api/tianjiang/v1/session",
    "/api/tianjiang/v1/session",
  ]);
});

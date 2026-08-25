import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  CentralAuthGateway,
  createTestOnlyLoopbackPolicy,
  type CentralSession,
} from "../../src/tianjiang/auth/central-session";

test("个人资料和密码修改必须更新本地会话令牌与用户快照", async () => {
  const requests: Array<{ path: string; body: unknown; token?: string }> = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({
      path: request.url ?? "",
      body,
      token: Array.isArray(request.headers["x-token"])
        ? request.headers["x-token"][0]
        : request.headers["x-token"],
    });
    response.setHeader("content-type", "application/json");
    response.setHeader("new-token", `token-${requests.length}`);
    response.setHeader("new-expires-at", "2000000000");
    response.end(JSON.stringify({
      code: 0,
      data: {
        user: { id: 7, username: "creator_new", nickname: "新昵称" },
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务监听失败");
  const serverUrl = `http://127.0.0.1:${address.port}`;
  const gateway = new CentralAuthGateway(fetch, createTestOnlyLoopbackPolicy(serverUrl));
  const session: CentralSession = {
    id: "session-1",
    serverUrl,
    token: "token-old",
    expiresAt: Date.now() + 60_000,
    validatedAt: Date.now(),
    user: { id: 7, username: "creator", nickname: "创作者" },
  };

  try {
    const profileResult = await gateway.updateProfile(session, {
      username: "creator_new",
      nickname: "新昵称",
    });
    const profile = { id: 7, username: "creator_new", nickname: "新昵称" };
    assert.deepEqual(profileResult.user, profile);
    assert.equal(session.token, "token-old", "凭据提交前不得提前替换内存令牌");
    assert.equal(session.user.username, "creator");
    Object.assign(session, profileResult.session);

    const changed = await gateway.changePassword(session, {
      oldPassword: "SecurePass123!",
      newPassword: "NewSecure456!",
    });
    assert.deepEqual(changed.user, profile);
    assert.equal(session.token, "token-1", "密码凭据提交前不得提前替换内存令牌");
    Object.assign(session, changed.session);
    assert.equal(session.token, "token-2");
    assert.deepEqual(requests, [
      {
        path: "/api/tianjiang/v1/profile",
        body: { username: "creator_new", nickname: "新昵称" },
        token: "token-old",
      },
      {
        path: "/api/tianjiang/v1/profile/password",
        body: { oldPassword: "SecurePass123!", newPassword: "NewSecure456!" },
        token: "token-1",
      },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

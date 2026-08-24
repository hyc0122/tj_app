import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";

import loginRouter from "../../src/routes/tianjiang/auth/login";
import { centralAuthGateway } from "../../src/tianjiang/auth/auth-runtime";
import {
  CentralAuthGateway,
  CentralRequestError,
} from "../../src/tianjiang/auth/central-session";

const loginBody = {
  username: "alice",
  password: "WrongPass123!",
  captcha: "1234",
  captchaId: "captcha-id",
};

test("登录已知安全错误透传真实提示，未知错误安全回退且不泄密", async () => {
  const gateway = new CentralAuthGateway(async () => new Response(
    JSON.stringify({ code: 7, msg: "账号或密码错误" }),
    { status: 401, headers: { "content-type": "application/json" } },
  ));
  await assert.rejects(
    () => gateway.login(loginBody),
    (error: unknown) => {
      assert.ok(error instanceof CentralRequestError);
      assert.equal(error.message, "账号或密码错误");
      assert.equal(error.status, 401);
      return true;
    },
  );

  const mutable = centralAuthGateway as unknown as {
    login: typeof centralAuthGateway.login;
  };
  const original = mutable.login;
  mutable.login = async () => {
    throw CentralRequestError.fromResponse(
      "/api/tianjiang/v1/auth/login",
      401,
      { code: 7, msg: "账号或密码错误" },
    );
  };
  try {
    const response = await invokeLogin(loginBody);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      code: 7,
      message: "账号或密码错误",
    });
  } finally {
    mutable.login = original;
  }

  // 未知内部文案不得回显。
  mutable.login = async () => {
    throw CentralRequestError.fromResponse(
      "/api/tianjiang/v1/auth/login",
      500,
      { code: "INTERNAL", msg: "stack at /opt/app secret=xyz token=abc" },
    );
  };
  try {
    const response = await invokeLogin(loginBody);
    assert.equal(response.status, 401);
    const body = await response.json() as { message?: string };
    assert.equal(body.message, "中央认证失败");
    assert.doesNotMatch(JSON.stringify(body), /stack|secret|token=abc/i);
  } finally {
    mutable.login = original;
  }
});

async function invokeLogin(body: Record<string, unknown>): Promise<Response> {
  const app = express();
  app.use(express.json());
  app.use("/", loginRouter);
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    return await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

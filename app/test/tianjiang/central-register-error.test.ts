import assert from "node:assert/strict";
import test from "node:test";
import registerRouter from "../../src/routes/tianjiang/auth/register";
import { centralAuthGateway } from "../../src/tianjiang/auth/auth-runtime";
import { CentralAuthGateway } from "../../src/tianjiang/auth/central-session";

const validRegistration = {
  username: "creator",
  nickname: "创作者",
  password: "SecurePass123!",
  captcha: "1234",
  captchaId: "captcha-id",
};

interface RecordedResponse {
  statusCode: number;
  body: unknown;
  status(code: number): RecordedResponse;
  send(body: unknown): RecordedResponse;
}

function createRecordedResponse(): RecordedResponse {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

function registerHandler(): (request: unknown, response: RecordedResponse) => Promise<void> {
  // 直接调用路由末端处理器，避免为契约测试开启任何本地监听端口。
  const layer = (registerRouter as unknown as {
    stack: Array<{
      route?: {
        path: string;
        stack: Array<{ handle: (request: unknown, response: RecordedResponse) => Promise<void> }>;
      };
    }>;
  }).stack.find((candidate) => candidate.route?.path === "/");
  const handler = layer?.route?.stack.at(-1)?.handle;
  assert.ok(handler, "未找到注册路由处理器");
  return handler;
}

async function invokeRegisterRoute(error: unknown): Promise<RecordedResponse> {
  const originalRegister = centralAuthGateway.register;
  centralAuthGateway.register = async () => {
    throw error;
  };
  const response = createRecordedResponse();
  try {
    await registerHandler()({ body: validRegistration }, response);
    return response;
  } finally {
    centralAuthGateway.register = originalRegister;
  }
}

for (const scenario of [
  { status: 400, code: 7, message: "验证码错误" },
  { status: 400, code: "CAPTCHA_INVALID", message: "验证码错误" },
  { status: 409, code: "USERNAME_TAKEN", message: "用户名已存在" },
  { status: 422, code: "PASSWORD_POLICY", message: "密码不符合安全规则" },
]) {
  test(`注册链路保留中央安全业务错误：${scenario.code}`, async () => {
    const gateway = new CentralAuthGateway(async () => new Response(
      JSON.stringify({
        code: scenario.code,
        msg: scenario.message,
        request_id: "internal-request-id",
      }),
      {
        status: scenario.status,
        headers: { "content-type": "application/json" },
      },
    ));

    let businessError: unknown;
    await assert.rejects(gateway.register(validRegistration), (error: unknown) => {
      businessError = error;
      assert.equal((error as Error).constructor.name, "CentralRequestError");
      assert.equal((error as { status?: unknown }).status, scenario.status);
      assert.equal((error as { code?: unknown }).code, scenario.code);
      assert.equal((error as Error).message, scenario.message);
      return true;
    });

    const response = await invokeRegisterRoute(businessError);
    assert.equal(response.statusCode, scenario.status);
    assert.deepEqual(response.body, {
      code: scenario.code,
      message: scenario.message,
    });
    assert.doesNotMatch(JSON.stringify(response.body), /request-id|stack|api\.j11\.com\.cn/i);
  });
}

test("注册链路不会把中央内部地址或凭据提示返回浏览器", async () => {
  const gateway = new CentralAuthGateway(async () => new Response(
    JSON.stringify({
      code: "USERNAME_TAKEN",
      msg: "详情：https://10.0.0.8/debug?token=secret-value",
    }),
    {
      status: 409,
      headers: { "content-type": "application/json" },
    },
  ));

  let businessError: unknown;
  await assert.rejects(gateway.register(validRegistration), (error: unknown) => {
    businessError = error;
    assert.equal((error as Error).message, "注册申请未受理，请检查填写内容");
    return true;
  });

  const response = await invokeRegisterRoute(businessError);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, {
    code: 400,
    message: "注册申请未受理，请检查填写内容",
  });
  assert.doesNotMatch(JSON.stringify(response.body), /10\.0\.0\.8|token|secret/i);
});

for (const unsafe of [
  { status: 400, code: 7, message: "request_id: 550e8400-e29b-41d4-a716-446655440000" },
  { status: 400, code: 7, message: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature" },
  { status: 400, code: "sk-proj-SECRET", message: "验证码错误" },
  { status: 400, code: "TOKEN:SECRET", message: "验证码错误" },
  { status: 400, code: 0, message: "验证码错误" },
  // 登录专用错误即使内容安全，也不能通过注册路径返回 401。
  { status: 401, code: 7, message: "账号或密码错误" },
  { status: 409, code: "UNKNOWN_CONFLICT", message: "未知冲突" },
  { status: 422, code: "UNKNOWN_RULE", message: "未知规则" },
]) {
  test(`注册链路拒绝非白名单中央错误字段：${String(unsafe.code)}`, async () => {
    const gateway = new CentralAuthGateway(async () => new Response(
      JSON.stringify({ code: unsafe.code, msg: unsafe.message }),
      {
        status: unsafe.status,
        headers: { "content-type": "application/json" },
      },
    ));

    let businessError: unknown;
    await assert.rejects(gateway.register(validRegistration), (error: unknown) => {
      businessError = error;
      return true;
    });

    const response = await invokeRegisterRoute(businessError);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, {
      code: 400,
      message: "注册申请未受理，请检查填写内容",
    });
    assert.doesNotMatch(
      JSON.stringify(response.body),
      /request_id|550e8400|Bearer|eyJhbGci|sk-proj|TOKEN:SECRET/i,
    );
  });
}

test("注册网络错误继续返回清晰且不泄密的 503 提示", async () => {
  const gateway = new CentralAuthGateway(async () => {
    throw new TypeError("fetch https://internal.example?token=secret failed");
  });

  let networkError: unknown;
  await assert.rejects(gateway.register(validRegistration), (error: unknown) => {
    networkError = error;
    return true;
  });

  const response = await invokeRegisterRoute(networkError);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, {
    code: "CENTRAL_API_UNREACHABLE",
    message: "中央 API 不可达，请检查网络连接或稍后重试。",
  });
  assert.doesNotMatch(JSON.stringify(response.body), /internal\.example|token|secret/i);
});

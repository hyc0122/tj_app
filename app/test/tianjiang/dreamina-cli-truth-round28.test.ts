/**
 * P0 RED：即梦 CLI 真值必须以真实退出码为准，禁止缓存“已登录”与无效路径并存。
 * 只使用仓库 fake CLI，禁止扫描磁盘或调用真实 dreamina。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import express from "express";

import {
  activateUserDatabase,
  accountDb,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { enterUserStorage, runWithUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { writeDreaminaRuntimeState } from "../../src/tianjiang/model-providers/dreamina-cli/runtime-state-store";
import { createUniqueWorktreeRoot, closeActivatedWorkspaceRuntime } from "./helpers/worktree-runtime";

const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function jsonRequest(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

function payloadOf(body: any): any {
  return body?.data ?? body;
}

async function createApp(identity: { issuer: string; userId: number }): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    enterUserStorage(identity);
    next();
  });
  for (const name of [
    "getStatus",
    "getSettings",
    "updateSettings",
    "runSelfCheck",
    "refreshAccount",
    "checkCli",
    "checkLogin",
  ] as const) {
    try {
      const loaded = await import(`../../src/routes/setting/dreaminaCli/${name}.ts`);
      app.use(`/api/setting/dreaminaCli/${name}`, loaded.default);
    } catch {
      // GREEN 前新路由尚未创建时，后续 HTTP 必须得到真实 404。
    }
  }
  return app;
}

async function withCliHarness(
  label: string,
  scenario: string,
  run: (input: { base: string; logFile: string }) => Promise<void>,
): Promise<void> {
  const root = createUniqueWorktreeRoot(label);
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPath = process.env.PATH;
  const originalScenario = process.env.DREAMINA_FAKE_SCENARIO;
  const originalLog = process.env.DREAMINA_FAKE_LOG;
  const logFile = path.join(root, "cli.log");
  const identity = { issuer: "https://api.j11.com.cn", userId: 9828 };

  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    process.env.PATH = root;
    process.env.DREAMINA_FAKE_SCENARIO = scenario;
    process.env.DREAMINA_FAKE_LOG = logFile;
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const app = await createApp(identity);
      const { server, port } = await listen(app);
      try {
        await run({ base: `http://127.0.0.1:${port}/api/setting/dreaminaCli`, logFile });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalScenario === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
    else process.env.DREAMINA_FAKE_SCENARIO = originalScenario;
    if (originalLog === undefined) delete process.env.DREAMINA_FAKE_LOG;
    else process.env.DREAMINA_FAKE_LOG = originalLog;
  }
}

test("缓存已登录但路径无效时，getStatus 不得把账户显示为已登录真值", async () => {
  await withCliHarness("dreamina-truth-stale-login", "default", async ({ base, logFile }) => {
    await writeDreaminaRuntimeState({
      executablePath: null,
      install: {
        state: "not_installed",
        version: null,
        executablePath: null,
        managed: false,
        checkedAt: Date.now(),
        reason: "未配置可执行文件",
      },
      account: {
        state: "logged_in",
        points: "9999",
        refreshedAt: Date.now(),
        reason: "陈旧缓存",
      },
    });
    if (fs.existsSync(logFile)) fs.writeFileSync(logFile, "");

    const status = await jsonRequest(`${base}/getStatus`);
    assert.equal(status.status, 200, `getStatus 失败: ${JSON.stringify(status.body)}`);
    const payload = payloadOf(status.body);
    assert.notEqual(payload.account?.state, "logged_in", "无效路径不得继续返回已登录");
    assert.match(String(payload.account?.lastKnownState ?? ""), /logged_in/);
    assert.equal(payload.account?.verified, false);
    assert.match(String(payload.install?.state ?? ""), /not_installed|failed/);
    const cliLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    assert.equal(cliLog.trim(), "", "getStatus 不得拉起 CLI");
  });
});

test("旧设置为空时必须默认使用 dreamina 命令并从安全 PATH 解析真实文件", async () => {
  const previousTestExe = process.env.DREAMINA_TEST_EXECUTABLE;
  try {
    await withCliHarness("dreamina-truth-default-command", "default", async ({ base }) => {
      await accountDb("o_dreaminaCliSettings").where({ id: 1 }).update({ executablePath: null });
      process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;

      const settingsResponse = await jsonRequest(`${base}/getSettings`);
      assert.equal(settingsResponse.status, 200);
      assert.equal(payloadOf(settingsResponse.body).executablePath, "dreamina");

      const { resolveDreaminaExecutable } = await import(
        "../../src/tianjiang/model-providers/dreamina-cli/cli-truth"
      );
      const resolved = await resolveDreaminaExecutable();
      assert.equal(path.normalize(resolved), path.normalize(FAKE_CLI));
    });
  } finally {
    if (previousTestExe === undefined) delete process.env.DREAMINA_TEST_EXECUTABLE;
    else process.env.DREAMINA_TEST_EXECUTABLE = previousTestExe;
  }
});

test("显式检测缺失可执行文件必须原子写成未安装且账户未知", async () => {
  await withCliHarness("dreamina-truth-missing-exe", "default", async ({ base }) => {
    await writeDreaminaRuntimeState({
      executablePath: path.join(process.cwd(), "missing-dreamina.exe"),
      install: { state: "installed", version: "1.0.0", executablePath: "old.exe", managed: false, checkedAt: 1 },
      account: { state: "logged_in", points: "1280", refreshedAt: 1 },
    });

    const checked = await jsonRequest(`${base}/runSelfCheck`, { method: "POST" });
    assert.notEqual(checked.status, 404, "runSelfCheck 必须存在");
    assert.ok([200, 400].includes(checked.status), `自检状态异常: ${checked.status}`);
    const result = payloadOf(checked.body);
    assert.notEqual(result.account?.state, "logged_in");
    assert.match(String(result.install?.state ?? ""), /not_installed|failed/);

    const persisted = await accountDb("o_dreaminaCliRuntimeState").where({ id: 1 }).first();
    assert.match(String(persisted?.installState ?? ""), /not_installed|failed/);
    assert.notEqual(persisted?.accountState, "logged_in", "检测失败后不得保留旧登录缓存");
  });
});

test("保存合法 fake CLI 路径后，检测 CLI 必须回显同一规范绝对路径且不推断登录", async () => {
  await withCliHarness("dreamina-truth-check-cli", "not_logged_in", async ({ base, logFile }) => {
    const saved = await jsonRequest(`${base}/updateSettings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executablePath: FAKE_CLI }),
    });
    assert.equal(saved.status, 200, `保存路径失败: ${JSON.stringify(saved.body)}`);
    const savedPayload = payloadOf(saved.body);
    assert.equal(path.normalize(String(savedPayload.executablePath)), path.normalize(FAKE_CLI));

    const afterSave = await jsonRequest(`${base}/getStatus`);
    const afterSavePayload = payloadOf(afterSave.body);
    assert.notEqual(afterSavePayload.account?.state, "logged_in", "保存路径后不得直接视为已登录");

    if (fs.existsSync(logFile)) fs.writeFileSync(logFile, "");
    const checked = await jsonRequest(`${base}/checkCli`, { method: "POST" });
    assert.notEqual(checked.status, 404, "checkCli 生产路由必须存在");
    assert.equal(checked.status, 200, `checkCli 失败: ${JSON.stringify(checked.body)}`);
    const cli = payloadOf(checked.body);
    assert.equal(cli.available, true);
    assert.equal(path.normalize(String(cli.resolvedExecutablePath)), path.normalize(FAKE_CLI));
    assert.match(String(cli.version ?? ""), /1\.4\.4/);
    assert.notEqual(cli.account?.state, "logged_in", "检测 CLI 不得推断登录");

    const commands = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { args: string[] })
      : [];
    assert.ok(commands.some((item) => item.args[0] === "version" || item.args[0] === "-h"));
    assert.equal(commands.some((item) => item.args[0] === "user_credit"), false, "检测 CLI 不得查询积分");
  });
});

test("user_credit 退出码非 0 必须记为未登录，退出码 0 即使无积分也是已登录", async () => {
  await withCliHarness("dreamina-truth-login-exit", "not_logged_in", async ({ base }) => {
    await jsonRequest(`${base}/updateSettings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executablePath: FAKE_CLI }),
    });

    const loggedOut = await jsonRequest(`${base}/checkLogin`, { method: "POST" });
    assert.notEqual(loggedOut.status, 404, "checkLogin 生产路由必须存在");
    assert.equal(loggedOut.status, 200, `checkLogin 失败: ${JSON.stringify(loggedOut.body)}`);
    const outPayload = payloadOf(loggedOut.body);
    assert.equal(outPayload.account?.state, "logged_out");
    assert.equal(outPayload.account?.verified, true);
    assert.equal(outPayload.account?.points, undefined);
  });

  await withCliHarness("dreamina-truth-login-no-credit", "logged_in_no_credit", async ({ base }) => {
    await jsonRequest(`${base}/updateSettings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executablePath: FAKE_CLI }),
    });
    const loggedIn = await jsonRequest(`${base}/checkLogin`, { method: "POST" });
    assert.equal(loggedIn.status, 200, `无积分登录检测失败: ${JSON.stringify(loggedIn.body)}`);
    const inPayload = payloadOf(loggedIn.body);
    assert.equal(inPayload.account?.state, "logged_in");
    assert.equal(inPayload.account?.verified, true);
    assert.equal(inPayload.account?.points, undefined);
    assert.match(String(inPayload.account?.reason ?? ""), /CLI 未返回积分/);
  });

  await withCliHarness("dreamina-truth-refresh-credit", "default", async ({ base }) => {
    await jsonRequest(`${base}/updateSettings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executablePath: FAKE_CLI }),
    });
    const refreshed = await jsonRequest(`${base}/refreshAccount`, { method: "POST" });
    assert.equal(refreshed.status, 200);
    const payload = payloadOf(refreshed.body);
    assert.equal(payload.account?.state ?? (payload.loggedIn ? "logged_in" : ""), "logged_in");
    assert.equal(String(payload.account?.points ?? payload.points ?? ""), "1280");
  });
});

test("必须解析参考实现的 JSON 版本与 total_credit 积分字段", async () => {
  await withCliHarness("dreamina-truth-reference-output", "reference_output", async ({ base }) => {
    await jsonRequest(`${base}/updateSettings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executablePath: FAKE_CLI }),
    });

    const checked = await jsonRequest(`${base}/checkCli`, { method: "POST" });
    assert.equal(checked.status, 200, `检测 CLI 失败: ${JSON.stringify(checked.body)}`);
    assert.equal(payloadOf(checked.body).version, "54f1bdf-dirty");

    const loggedIn = await jsonRequest(`${base}/checkLogin`, { method: "POST" });
    assert.equal(loggedIn.status, 200, `检测登录失败: ${JSON.stringify(loggedIn.body)}`);
    const payload = payloadOf(loggedIn.body);
    assert.equal(payload.account?.state, "logged_in");
    assert.equal(payload.account?.verified, true);
    assert.equal(payload.account?.points, "29");
    assert.equal(payload.account?.reason, undefined);
  });
});

test("安装入口必须执行参考项目的官方命令，禁止继续直链下载 EXE", async () => {
  const routeSource = fs.readFileSync(
    path.resolve(__dirname, "../../src/routes/setting/dreaminaCli/install.ts"),
    "utf8",
  );
  assert.match(routeSource, /official-command-installer/);
  assert.doesNotMatch(routeSource, /managed-installer/);

  const loaded = await import(
    "../../src/tianjiang/model-providers/dreamina-cli/official-command-installer"
  ).catch(() => ({}));
  const installer = loaded as {
    OFFICIAL_DREAMINA_INSTALL_COMMAND?: string;
    bindOfficialDreaminaInstallTest?: (input?: {
      bashPath: string;
      runner: (input: { executablePath: string; args: readonly string[] }) => Promise<{
        exitCode: number | null;
        stdout: string;
        stderr: string;
        timedOut: boolean;
      }>;
    }) => void;
    installDreaminaWithOfficialCommand?: (input: { confirm: true }) => Promise<{ ok: boolean; command?: string }>;
  };
  assert.equal(typeof installer.bindOfficialDreaminaInstallTest, "function");
  assert.equal(typeof installer.installDreaminaWithOfficialCommand, "function");

  const calls: Array<{ executablePath: string; args: readonly string[] }> = [];
  installer.bindOfficialDreaminaInstallTest!({
    bashPath: process.execPath,
    runner: async (input) => {
      calls.push(input);
      return { exitCode: 0, stdout: "installed", stderr: "", timedOut: false };
    },
  });
  try {
    const result = await installer.installDreaminaWithOfficialCommand!({ confirm: true });
    assert.equal(result.ok, true);
    assert.equal(result.command, "curl -s https://jimeng.jianying.com/cli | bash");
    assert.deepEqual(calls, [{
      executablePath: process.execPath,
      args: ["-lc", "curl -s https://jimeng.jianying.com/cli | bash"],
    }]);
  } finally {
    installer.bindOfficialDreaminaInstallTest!();
  }
});

test("生产 router 必须挂载 checkCli 与 checkLogin，不能只靠测试动态 import", async () => {
  const appRoot = path.resolve(__dirname, "../..");
  const previousCwd = process.cwd();
  try {
    process.chdir(appRoot);
    const generateRouter = (await import("../../src/core")).default;
    await generateRouter();
  } finally {
    process.chdir(previousCwd);
  }
  const generated = fs.readFileSync(path.join(appRoot, "src/router.ts"), "utf8");
  assert.match(generated, /setting\/dreaminaCli\/checkCli/);
  assert.match(generated, /setting\/dreaminaCli\/checkLogin/);
});

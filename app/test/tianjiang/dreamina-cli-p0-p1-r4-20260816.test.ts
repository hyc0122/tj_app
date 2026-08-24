/**
 * R4 RED：裸 dreamina 必须解析并持久化绝对路径；安装/修复走官方命令；
 * 新建项目模型不依赖 CLI 检测；图片模型展示名必须对应真实 --model_version。
 * 只使用仓库 fake CLI，禁止扫盘、真实安装或收费生成。
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
import { invalidateDreaminaCapabilityCache } from "../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import { listNativeDreaminaModels } from "../../src/tianjiang/model-providers/native-provider-registry";
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

function readCliCommands(logFile: string): string[][] {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { args?: string[] }).args ?? []);
}

async function createApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    enterUserStorage({ issuer: "https://api.j11.com.cn", userId: 8616 });
    next();
  });
  for (const name of [
    "getStatus",
    "getSettings",
    "updateSettings",
    "checkCli",
    "checkLogin",
    "refreshAccount",
    "startAuthorization",
    "install",
    "repair",
  ] as const) {
    const loaded = await import(`../../src/routes/setting/dreaminaCli/${name}.ts`);
    app.use(`/api/setting/dreaminaCli/${name}`, loaded.default);
  }
  return app;
}

async function withHarness(
  label: string,
  run: (input: { base: string; logFile: string }) => Promise<void>,
  options: { testExecutable?: string; scenario?: string } = {},
): Promise<void> {
  const root = createUniqueWorktreeRoot(label);
  const original = {
    cwd: process.cwd(),
    nodeEnv: process.env.NODE_ENV,
    path: process.env.PATH,
    scenario: process.env.DREAMINA_FAKE_SCENARIO,
    log: process.env.DREAMINA_FAKE_LOG,
    testExe: process.env.DREAMINA_TEST_EXECUTABLE,
  };
  const logFile = path.join(root, "cli.log");
  const identity = { issuer: "https://api.j11.com.cn", userId: 8616 };
  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    process.env.PATH = root;
    process.env.DREAMINA_FAKE_SCENARIO = options.scenario ?? "default";
    process.env.DREAMINA_FAKE_LOG = logFile;
    if (options.testExecutable) process.env.DREAMINA_TEST_EXECUTABLE = options.testExecutable;
    else delete process.env.DREAMINA_TEST_EXECUTABLE;
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    await runWithUserStorage(identity, async () => {
      const app = await createApp();
      const { server, port } = await listen(app);
      try {
        await run({ base: `http://127.0.0.1:${port}/api/setting/dreaminaCli`, logFile });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(original.cwd);
    if (original.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original.nodeEnv;
    if (original.path === undefined) delete process.env.PATH;
    else process.env.PATH = original.path;
    if (original.scenario === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
    else process.env.DREAMINA_FAKE_SCENARIO = original.scenario;
    if (original.log === undefined) delete process.env.DREAMINA_FAKE_LOG;
    else process.env.DREAMINA_FAKE_LOG = original.log;
    if (original.testExe === undefined) delete process.env.DREAMINA_TEST_EXECUTABLE;
    else process.env.DREAMINA_TEST_EXECUTABLE = original.testExe;
  }
}

test("配置裸 dreamina 时检测必须返回并持久化绝对路径，后续授权/登录/积分复用同一路径", async () => {
  await withHarness("r4-bare-dreamina-persist", async ({ base, logFile }) => {
    const saved = await jsonRequest(`${base}/updateSettings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executablePath: "dreamina" }),
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(payloadOf(saved.body).executablePath, "dreamina");

    const checked = await jsonRequest(`${base}/checkCli`, { method: "POST" });
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    const cli = payloadOf(checked.body);
    assert.equal(cli.available, true);
    assert.equal(path.normalize(String(cli.resolvedExecutablePath)), path.normalize(FAKE_CLI));

    const settings = payloadOf((await jsonRequest(`${base}/getSettings`)).body);
    assert.equal(
      path.normalize(String(settings.executablePath)),
      path.normalize(FAKE_CLI),
      "检测成功后必须把绝对路径写入设置，不能继续保存裸命令",
    );

    delete process.env.DREAMINA_TEST_EXECUTABLE;
    if (fs.existsSync(logFile)) fs.writeFileSync(logFile, "");

    const authorized = await jsonRequest(`${base}/startAuthorization`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    assert.notEqual(authorized.status, 404);
    const authText = JSON.stringify(authorized.body);
    assert.equal(authText.includes("即梦 CLI 可执行文件不存在"), false, authText);

    const login = await jsonRequest(`${base}/checkLogin`, { method: "POST" });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const credit = await jsonRequest(`${base}/refreshAccount`, { method: "POST" });
    assert.equal(credit.status, 200, JSON.stringify(credit.body));

    const commands = readCliCommands(logFile);
    assert.ok(commands.length > 0, "授权/登录/积分必须真实拉起已解析 CLI");
    assert.equal(commands.some((args) => args.includes("text2image") || args.includes("text2video")), false);
  }, { testExecutable: FAKE_CLI, scenario: "default" });
});

test("PATH 不含 CLI 时必须返回未安装，不得沿用缓存已安装/已登录", async () => {
  await withHarness("r4-missing-path-no-cache", async ({ base, logFile }) => {
    await writeDreaminaRuntimeState({
      executablePath: "dreamina",
      install: {
        state: "installed",
        version: "1.4.4",
        executablePath: "dreamina",
        managed: false,
        checkedAt: 1,
      },
      account: { state: "logged_in", points: "9999", refreshedAt: 1 },
    });
    await jsonRequest(`${base}/updateSettings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executablePath: "dreamina" }),
    });
    if (fs.existsSync(logFile)) fs.writeFileSync(logFile, "");

    const checked = await jsonRequest(`${base}/checkCli`, { method: "POST" });
    assert.ok([200, 400].includes(checked.status));
    const cli = payloadOf(checked.body);
    assert.notEqual(cli.available, true);
    assert.match(String(cli.install?.state ?? cli.installState ?? ""), /not_installed|failed/);

    const status = payloadOf((await jsonRequest(`${base}/getStatus`)).body);
    assert.notEqual(status.account?.state, "logged_in");
    assert.notEqual(status.install?.state, "installed");
    assert.equal(readCliCommands(logFile).some((args) => args[0] === "user_credit"), false);
  });
});

test("安装和修复都必须调用官方命令安装器，旧下载器调用数为 0", async () => {
  const installSource = fs.readFileSync(
    path.resolve(__dirname, "../../src/routes/setting/dreaminaCli/install.ts"),
    "utf8",
  );
  const repairSource = fs.readFileSync(
    path.resolve(__dirname, "../../src/routes/setting/dreaminaCli/repair.ts"),
    "utf8",
  );
  assert.match(installSource, /official-command-installer/);
  assert.match(repairSource, /official-command-installer/);
  assert.doesNotMatch(installSource, /managed-installer/);
  assert.doesNotMatch(repairSource, /managed-installer/);

  const official = await import("../../src/tianjiang/model-providers/dreamina-cli/official-command-installer");
  const calls: Array<{ args: readonly string[] }> = [];
  official.bindOfficialDreaminaInstallTest({
    bashPath: process.execPath,
    runner: async (input) => {
      calls.push({ args: input.args });
      return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false };
    },
  });
  try {
    const installed = await official.installDreaminaWithOfficialCommand({ confirm: true });
    assert.equal(installed.ok, true);
    const repaired = await official.installDreaminaWithOfficialCommand({ confirm: true });
    assert.equal(repaired.ok, true);
    assert.equal(installSource.includes("managed-installer"), false);
    assert.equal(repairSource.includes("managed-installer"), false);
    assert.deepEqual(calls.map((item) => item.args), [
      ["-lc", "curl -s https://jimeng.jianying.com/cli | bash"],
      ["-lc", "curl -s https://jimeng.jianying.com/cli | bash"],
    ]);
  } finally {
    official.bindOfficialDreaminaInstallTest();
  }
});

test("未检测 CLI 时新建项目即梦模型仍可见可选择，且零 CLI 进程", async () => {
  invalidateDreaminaCapabilityCache();
  const before = process.env.DREAMINA_FAKE_LOG;
  const logFile = path.join(createUniqueWorktreeRoot("r4-catalog-no-cli"), "cli.log");
  process.env.DREAMINA_FAKE_LOG = logFile;
  try {
    const image = listNativeDreaminaModels("image");
    const video = listNativeDreaminaModels("video");
    assert.equal(image.some((item) => item.disabled === true && /尚未检测即梦 CLI/.test(String(item.disabledReason ?? ""))), false);
    assert.equal(video.some((item) => item.disabled === true && /尚未检测即梦 CLI/.test(String(item.disabledReason ?? ""))), false);
    assert.ok(image.every((item) => item.disabled !== true), "未检测时图片模型必须可选择");
    assert.ok(video.every((item) => item.disabled !== true), "未检测时视频模型必须可选择");
    assert.equal(fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim() : "", "");
  } finally {
    if (before === undefined) delete process.env.DREAMINA_FAKE_LOG;
    else process.env.DREAMINA_FAKE_LOG = before;
    invalidateDreaminaCapabilityCache();
  }
});

test("图片模型展示名称必须对应真实 CLI --model_version，且不得发明 Lite 假映射", async () => {
  invalidateDreaminaCapabilityCache();
  const { parseDreaminaImageModel } = await import("../../src/tianjiang/storyboard/storyboard-generation-service");
  const items = listNativeDreaminaModels("image");
  const expected = [
    { label: "Seedream 5.0 Pro", version: "5.0" },
    { label: "Seedream 4.7", version: "4.7" },
    { label: "Seedream 4.6", version: "4.6" },
    { label: "Seedream 4.5", version: "4.5" },
  ];
  for (const item of expected) {
    const found = items.find((entry) => entry.label === item.label);
    assert.ok(found, `缺少展示名称 ${item.label}`);
    assert.equal(found?.value, `dreamina-cli:${item.version}`);
    assert.equal(parseDreaminaImageModel(String(found?.value)), item.version);
  }
  assert.equal(items.some((item) => /lite|5\.0-lite/i.test(`${item.label} ${item.value}`)), false);
});

test("缺 CLI 时正式生成必须失败关闭且零收费命令", async () => {
  await withHarness("r4-generate-fail-closed", async ({ logFile }) => {
    const { resolveDreaminaExecutable } = await import("../../src/tianjiang/model-providers/dreamina-cli/cli-truth");
    const { createDreaminaCliProvider } = await import("../../src/tianjiang/model-providers/dreamina-cli/provider");
    await assert.rejects(
      () => resolveDreaminaExecutable("dreamina"),
      /未安装|未在安全 PATH|不存在/,
    );
    if (fs.existsSync(logFile)) fs.writeFileSync(logFile, "");
    await assert.rejects(() => createDreaminaCliProvider({ executablePath: "dreamina" }));
    const commands = readCliCommands(logFile);
    assert.equal(commands.some((args) => ["text2image", "image2image", "text2video", "image2video"].includes(args[0] ?? "")), false);
  });
});

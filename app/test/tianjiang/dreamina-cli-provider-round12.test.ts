/**
 * Task 9 RED：即梦 CLI 适配器必须打到生产设置/模型目录入口。
 * 只使用 fake-dreamina-cli.cjs，禁止调用真实 dreamina 或收费接口。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import express from "express";

import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { enterUserStorage } from "../../src/tianjiang/runtime/user-storage-context";

const PROJECT = "11111111-1111-4111-a111-111111111111";
const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");
const MODES = [
  "text2image",
  "image2image",
  "text2video",
  "image2video",
  "frames2video",
  "multiframe2video",
  "multimodal2video",
] as const;

const ALLOWED_HEADS = new Set([
  "version",
  "-h",
  "--help",
  "user_credit",
  "session",
  "query_result",
  "list_task",
  "logout",
  ...MODES,
]);

function fixtureRoot(): string {
  return path.resolve(process.cwd(), "..", ".tmp", "dreamina-provider-t9");
}

function readLog(logFile: string): Array<{ args: string[] }> {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[] });
}

async function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function mountDreaminaRoutes(app: express.Express): Promise<void> {
  const names = ["getStatus", "getSettings", "updateSettings", "runSelfCheck", "logout"] as const;
  for (const name of names) {
    try {
      const loaded = await import(`../../src/routes/setting/dreaminaCli/${name}.ts`);
      app.use(`/api/setting/dreaminaCli/${name}`, loaded.default);
    } catch {
      // GREEN 前生产文件尚未创建，后续 HTTP 必须得到真实 404。
    }
  }
}

async function createProductionApp(identity: { issuer: string; userId: number }): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    enterUserStorage(identity);
    next();
  });
  const { default: getModelList } = await import("../../src/routes/modelSelect/getModelList");
  app.use("/api/modelSelect/getModelList", getModelList);
  await mountDreaminaRoutes(app);
  return app;
}

async function jsonRequest(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
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

function serializeBody(body: unknown): string {
  return JSON.stringify(body ?? {});
}

test("生产设置入口必须探测假 CLI，且不回传登录凭据", async () => {
  const root = fixtureRoot();
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPath = process.env.PATH;
  const originalScenario = process.env.DREAMINA_FAKE_SCENARIO;
  const originalLog = process.env.DREAMINA_FAKE_LOG;
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const logFile = path.join(root, "cli.log");
  const identity = { issuer: "https://api.j11.com.cn", userId: 9001 };

  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    process.env.PATH = root;
    process.env.DREAMINA_FAKE_SCENARIO = "default";
    process.env.DREAMINA_FAKE_LOG = logFile;
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);

    const app = await createProductionApp(identity);
    const { server, port } = await listen(app);
    const base = `http://127.0.0.1:${port}/api/setting/dreaminaCli`;
    try {
      const updated = await jsonRequest(`${base}/updateSettings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          executablePath: FAKE_CLI,
          maxConcurrency: 1,
          pauseNewClaims: false,
        }),
      });
      assert.notEqual(updated.status, 404, "updateSettings 生产路由必须存在");
      assert.equal(updated.status, 200);

      const rejected = await jsonRequest(`${base}/updateSettings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ executablePath: FAKE_CLI, maxConcurrency: 9 }),
      });
      assert.notEqual(rejected.status, 200, "并发 9 必须被拒绝");

      const selfCheck = await jsonRequest(`${base}/runSelfCheck`, { method: "POST" });
      assert.notEqual(selfCheck.status, 404, "runSelfCheck 生产路由必须存在");
      assert.equal(selfCheck.status, 200);
      const credit = selfCheck.body?.data ?? selfCheck.body;
      assert.equal(credit.loggedIn, true);
      assert.ok(credit.creditBalance !== undefined);
      assert.doesNotMatch(serializeBody(selfCheck.body), /cookie|token|device_code|user_code/i);

      const status = await jsonRequest(`${base}/getStatus`);
      assert.notEqual(status.status, 404, "getStatus 生产路由必须存在");
      assert.equal(status.status, 200);
      const payload = status.body?.data ?? status.body;
      assert.equal(payload.install?.state, "installed");
      assert.match(String(payload.install?.version ?? ""), /1\.4\.4/);
      assert.equal(payload.account?.state, "logged_in");
      const dumped = serializeBody(status.body);
      assert.doesNotMatch(dumped, /cookie|token|device_code|user_code|credential/i);
      assert.ok(payload.capability || payload.queue);

      const logout = await jsonRequest(`${base}/logout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      assert.notEqual(logout.status, 404, "logout 生产路由必须存在");
      assert.equal(logout.status, 200);

      const calls = readLog(logFile);
      assert.ok(calls.length > 0, "必须实际拉起假 CLI");
      for (const call of calls) {
        assert.ok(ALLOWED_HEADS.has(call.args[0]!), `禁止执行未允许命令: ${call.args[0]}`);
        assert.ok(!call.args.includes("login"));
        assert.ok(!call.args.includes("relogin"));
        assert.ok(call.args.every((item) => !/[\n\r\0]/.test(item)));
        assert.ok(call.args.every((item) => !/[<>|]/.test(item)));
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalScenario === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
    else process.env.DREAMINA_FAKE_SCENARIO = originalScenario;
    if (originalLog === undefined) delete process.env.DREAMINA_FAKE_LOG;
    else process.env.DREAMINA_FAKE_LOG = originalLog;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 可能短暂锁住 WAL；不影响合同断言。
    }
  }
});

test("getModelList 必须合并原生目录，缺失能力时禁用而不是静默消失", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", "dreamina-models-t9");
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPath = process.env.PATH;
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const identity = { issuer: "https://api.j11.com.cn", userId: 9002 };

  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    process.env.PATH = root;
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);

    const app = await createProductionApp(identity);
    const { server, port } = await listen(app);
    try {
      const listed = await jsonRequest(`http://127.0.0.1:${port}/api/modelSelect/getModelList`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "image" }),
      });
      assert.notEqual(listed.status, 404, "getModelList 必须继续提供生产入口");
      assert.equal(listed.status, 200);
      const listedPayload = listed.body?.data ?? listed.body;
      const models = (Array.isArray(listedPayload) ? listedPayload : listedPayload?.items) as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(models));
      const native = models.filter((item) => String(item.value ?? "").startsWith("dreamina-cli:"));
      assert.ok(native.length >= 2, "原生图片模型必须出现在目录中");
      for (const item of native) {
        assert.equal(item.providerKind, "native-local");
        assert.equal(item.providerId, "dreamina-cli");
        if (item.disabled) {
          assert.match(String(item.disabledReason ?? ""), /未安装|未登录|缺少|不支持|探测|尚未检测/);
        }
      }

      const vendorValues = models
        .filter((item) => !String(item.value ?? "").startsWith("dreamina-cli:"))
        .map((item) => item.value);
      const uniqueVendor = new Set(vendorValues);
      assert.equal(uniqueVendor.size, vendorValues.length, "既有供应商条目不得因合并被破坏");

      const videos = await jsonRequest(`http://127.0.0.1:${port}/api/modelSelect/getModelList`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "video" }),
      });
      const videoPayload = videos.body?.data ?? videos.body;
      const videoModels = (Array.isArray(videoPayload) ? videoPayload : videoPayload?.items) as Array<Record<string, unknown>>;
      const nativeVideo = videoModels.filter((item) => String(item.value ?? "").startsWith("dreamina-cli:"));
      assert.deepEqual(
        nativeVideo.map((item) => item.value),
        [
          "dreamina-cli:seedance2.0",
          "dreamina-cli:seedance2.0fast",
          "dreamina-cli:seedance2.0mini",
          "dreamina-cli:seedance2.0_vip",
          "dreamina-cli:seedance2.0fast_vip",
        ],
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 可能短暂锁住 WAL；不影响合同断言。
    }
  }
});

test("受信任适配器必须用 spawn(shell:false) 执行允许命令，并拒绝路径逃逸/超时敏感输出", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", "dreamina-adapter-t9");
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPath = process.env.PATH;
  const originalScenario = process.env.DREAMINA_FAKE_SCENARIO;
  const originalLog = process.env.DREAMINA_FAKE_LOG;
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const logFile = path.join(root, "adapter.log");
  const identity = { issuer: "https://api.j11.com.cn", userId: 9003 };

  try {
    process.chdir(root);
    process.env.NODE_ENV = "prod";
    process.env.PATH = root;
    process.env.DREAMINA_FAKE_LOG = logFile;
    process.env.DREAMINA_FAKE_SCENARIO = "default";
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);

    const app = await createProductionApp(identity);
    const { server, port } = await listen(app);
    try {
      const status = await jsonRequest(`http://127.0.0.1:${port}/api/setting/dreaminaCli/getStatus`);
      assert.notEqual(status.status, 404, "适配器测试必须先通过生产设置入口");

      enterUserStorage(identity);
      const providerModule = await import("../../src/tianjiang/model-providers/dreamina-cli/provider");
      const createProvider = providerModule.createDreaminaCliProvider;
      assert.equal(typeof createProvider, "function");

      const projectRoot = path.join(root, "project");
      const staging = path.join(root, "staging");
      fs.mkdirSync(path.join(projectRoot, "files"), { recursive: true });
      fs.mkdirSync(staging, { recursive: true });
      const safeImage = path.join(projectRoot, "files", "in.png");
      fs.writeFileSync(safeImage, "img");

      const provider = await createProvider({
        executablePath: FAKE_CLI,
        projectRoot,
        stagingDirectory: staging,
      });

      const probe = await provider.probe();
      assert.match(String(probe.version ?? ""), /1\.4\.4/);
      assert.ok(probe.modes || probe.capabilities);

      process.env.DREAMINA_FAKE_SCENARIO = "immediate";
      const completed = await provider.submit({
        mode: "text2image",
        prompt: "雨巷 & echo PWNED",
        ratio: "1:1",
        resolutionType: "2k",
      });
      assert.equal(completed.kind, "completed");

      process.env.DREAMINA_FAKE_SCENARIO = "submit_id";
      const submitted = await provider.submit({
        mode: "image2image",
        prompt: "水彩",
        images: [safeImage],
        resolutionType: "2k",
      });
      assert.equal(submitted.kind, "submitted");
      assert.equal((submitted as { submitId: string }).submitId, "sub-123");

      process.env.DREAMINA_FAKE_SCENARIO = "definite_failure";
      const failed = await provider.submit({ mode: "text2video", prompt: "坏参数" });
      assert.equal(failed.kind, "definite_failure");
      assert.equal(typeof (failed as { retryable: boolean }).retryable, "boolean");

      process.env.DREAMINA_FAKE_SCENARIO = "outcome_unknown";
      const unknown = await provider.submit({ mode: "text2image", prompt: "可能已受理" });
      assert.equal(unknown.kind, "outcome_unknown");

      await assert.rejects(
        () => provider.submit({
          mode: "image2image",
          prompt: "逃逸",
          images: [path.join(root, "..", "escape.png")],
        }),
        /受管|路径|逃逸/,
      );
      await assert.rejects(
        () => provider.submit({
          mode: "image2image",
          prompt: "UNC",
          images: ["\\\\server\\share\\a.png"],
        }),
        /受管|路径|UNC/,
      );

      const linkDir = path.join(root, "link-src");
      fs.mkdirSync(linkDir, { recursive: true });
      const linkTarget = path.join(linkDir, "secret.png");
      fs.writeFileSync(linkTarget, "secret");
      const linkPath = path.join(projectRoot, "files", "linked.png");
      try {
        fs.symlinkSync(linkTarget, linkPath);
        await assert.rejects(
          () => provider.submit({ mode: "image2image", prompt: "链接", images: [linkPath] }),
          /符号链接|symlink|受管/,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          // Windows 无权限建符号链接时仍必须拒绝绝对路径逃逸，上面已覆盖。
        } else {
          throw error;
        }
      }

      process.env.DREAMINA_FAKE_SCENARIO = "timeout";
      process.env.DREAMINA_CLI_TIMEOUT_MS = "1500";
      const timed = await provider.submit({ mode: "text2image", prompt: "超时" });
      delete process.env.DREAMINA_CLI_TIMEOUT_MS;
      assert.ok(timed.kind === "outcome_unknown" || timed.kind === "definite_failure");
      assert.doesNotMatch(JSON.stringify(timed), /SENSITIVE_COOKIE|X{100}/);

      process.env.DREAMINA_FAKE_SCENARIO = "truncate";
      const truncated = await provider.probe();
      assert.doesNotMatch(JSON.stringify(truncated), /SENSITIVE_COOKIE=abc\.secret\.token/);

      process.env.DREAMINA_FAKE_SCENARIO = "default";
      const session = await provider.ensureProjectSession(PROJECT, "雨巷分镜");
      assert.match(String(session), /sess-/);

      const calls = readLog(logFile);
      for (const call of calls) {
        assert.ok(ALLOWED_HEADS.has(call.args[0]!), `禁止执行未允许命令: ${call.args.join(" ")}`);
      }
      assert.ok(calls.some((call) => call.args[0] === "text2image" && call.args.some((item) => item.includes("PWNED"))));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalScenario === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
    else process.env.DREAMINA_FAKE_SCENARIO = originalScenario;
    if (originalLog === undefined) delete process.env.DREAMINA_FAKE_LOG;
    else process.env.DREAMINA_FAKE_LOG = originalLog;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 可能短暂锁住 WAL；不影响合同断言。
    }
  }
});

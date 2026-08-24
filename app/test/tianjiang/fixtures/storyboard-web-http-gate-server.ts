/**
 * Round27 Web/App 联合契约夹具：只启动本地 Express 与真实 SQLite。
 * 调度始终暂停，禁止启动即梦 CLI、供应商请求、OAuth 或任何收费动作。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";

import {
  accountDb,
  activateUserDatabase,
  db as activeDb,
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
} from "../../../src/utils/db";
import {
  DREAMINA_MODES,
  DREAMINA_VIDEO_MODELS,
  type DreaminaCapabilitySnapshot,
  type DreaminaMode,
} from "../../../src/tianjiang/model-providers/dreamina-cli/contracts";
import { writeDreaminaCapabilityCache } from "../../../src/tianjiang/model-providers/dreamina-cli/capability-cache";
import { writeDreaminaCliSettings } from "../../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { stopDreaminaSchedulerLoop } from "../../../src/tianjiang/model-providers/dreamina-cli/scheduler";
import { syncCoordinator } from "../../../src/tianjiang/runtime/runtime";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../../src/tianjiang/storyboard/storyboard-service";
import u from "../../../src/utils";

// 中文注释：使用保留的 .invalid 域名，夹具生命周期内即使误触网络也无法命中真实中央服务。
const IDENTITY = { issuer: "https://central.storyboard.test.invalid", userId: 9790 };
const PROJECT_UUID = "90909090-9090-4090-a090-909090909090";
const FAKE_CLI = path.resolve(__dirname, "fake-dreamina-cli.cjs");
const DATA_ROOT = path.resolve(process.env.STORYBOARD_GATE_DATA_ROOT ?? process.cwd());
const CLI_LOG = path.resolve(DATA_ROOT, "dreamina-cli-never-called.log");
const LOCAL_VENDOR_ID = "localshapegate";
const LOCAL_VENDOR_MODEL = `${LOCAL_VENDOR_ID}:local-image`;
const LOCAL_IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
let externalNetworkCallCount = 0;

const MODE_FIELDS: Record<DreaminaMode, readonly string[]> = {
  text2image: ["--prompt", "--ratio", "--resolution_type", "--model_version"],
  image2image: ["--prompt", "--images", "--ratio", "--resolution_type"],
  text2video: ["--prompt", "--duration", "--ratio", "--video_resolution", "--model_version"],
  image2video: ["--prompt", "--image", "--duration", "--video_resolution", "--model_version"],
  frames2video: ["--prompt", "--first", "--last", "--duration", "--video_resolution", "--model_version"],
  multiframe2video: ["--prompt", "--images", "--duration", "--video_resolution", "--model_version"],
  multimodal2video: [
    "--prompt",
    "--image",
    "--video",
    "--audio",
    "--duration",
    "--ratio",
    "--video_resolution",
    "--model_version",
  ],
};

function writeReadyCapability(): void {
  const snapshot: DreaminaCapabilitySnapshot = {
    installed: true,
    version: "web-http-gate",
    probedAt: Date.now(),
    loggedIn: true,
    modes: Object.fromEntries(DREAMINA_MODES.map((mode) => [mode, {
      enabled: true,
      fields: MODE_FIELDS[mode],
    }])) as DreaminaCapabilitySnapshot["modes"],
    capabilities: [...DREAMINA_MODES],
    videoModels: [...DREAMINA_VIDEO_MODELS],
  };
  writeDreaminaCapabilityCache({ state: "ready", snapshot, checkedAt: Date.now() });
}

async function countRows(tableName: string, column: string): Promise<number> {
  const row = await activeDb(tableName).count<{ total: number }>(`${column} as total`).first();
  return Number(row?.total ?? 0);
}

async function readState(): Promise<Record<string, unknown>> {
  const projectState = await runWithProjectStorage(PROJECT_UUID, async () => {
    const tasks = await activeDb("o_storyboardGenerationTask")
      .orderBy("createdAt")
      .orderBy("taskUuid")
      .select();
    const candidates = await activeDb("o_storyboardCandidate")
      .orderBy("createdAt")
      .orderBy("candidateUuid")
      .select();
    const hasOperations = await activeDb.schema.hasTable("o_storyboardGenerationOperation");
    const operations = hasOperations
      ? await activeDb("o_storyboardGenerationOperation")
        .orderBy("createdAt")
        .orderBy("clientOperationId")
        .select()
      : [];
    return {
      taskCount: await countRows("o_storyboardGenerationTask", "taskUuid"),
      operationCount: operations.length,
      candidateCount: candidates.length,
      operations: operations.map((row) => ({
        clientOperationId: String(row.clientOperationId ?? ""),
        state: String(row.state ?? ""),
        itemCount: Number(row.itemCount ?? 0),
      })),
      tasks: tasks.map((row) => ({
        taskUuid: String(row.taskUuid ?? ""),
        clientOperationId: row.clientOperationId == null ? null : String(row.clientOperationId),
        status: String(row.status ?? ""),
      })),
      candidates: candidates.map((row) => ({
        candidateUuid: String(row.candidateUuid ?? ""),
        shotUuid: String(row.shotUuid ?? ""),
        mediaType: String(row.mediaType ?? ""),
      })),
    };
  });
  const dispatches = await accountDb("o_dreaminaCliDispatch")
    .orderBy("createdAt")
    .orderBy("taskUuid")
    .select();
  const cliLines = fs.existsSync(CLI_LOG)
    ? fs.readFileSync(CLI_LOG, "utf8").split(/\r?\n/).filter(Boolean)
    : [];
  const generateCliCount = cliLines.filter((line) => {
    try {
      const args = (JSON.parse(line) as { args?: string[] }).args ?? [];
      const head = String(args[0] ?? "");
      if (head === "login" || head === "relogin" || head === "logout") return true;
      if (head.endsWith("2video") || head.endsWith("2image")) {
        return !args.includes("-h") && !args.includes("--help");
      }
      return false;
    } catch {
      return true;
    }
  }).length;
  return {
    ...projectState,
    dispatchCount: dispatches.length,
    dispatches: dispatches.map((row) => ({
      taskUuid: String(row.taskUuid ?? ""),
      clientOperationId: row.clientOperationId == null ? null : String(row.clientOperationId),
      queueState: String(row.queueState ?? ""),
    })),
    // 中文注释：联合门禁只禁止 login/生成命令；version/-h/user_credit/模式帮助属于启动检测。
    cliInvocationCount: generateCliCount,
    externalNetworkCallCount,
  };
}

async function installLocalVendor(): Promise<void> {
  const models = [{
    name: "联合门禁本地图片模型",
    modelName: "local-image",
    type: "image",
    mode: ["text"],
  }];
  // 中文注释：供应商函数只返回内置 1px 图片，不含 fetch/axios/SDK，禁止真实外调或收费。
  u.vendor.writeCode(LOCAL_VENDOR_ID, `
exports.vendor = {
  id: ${JSON.stringify(LOCAL_VENDOR_ID)},
  version: "2.0",
  name: "联合门禁本地供应商",
  author: "test",
  supportsMediaUrl: false,
  inputValues: {},
  models: ${JSON.stringify(models)}
};
exports.imageRequest = async function () {
  return ${JSON.stringify(LOCAL_IMAGE_BASE64)};
};
export {};
`);
  await accountDb("o_vendorConfig").insert({
    id: LOCAL_VENDOR_ID,
    inputValues: "{}",
    models: JSON.stringify(models),
    enable: 1,
  }).onConflict("id").merge({
    inputValues: "{}",
    models: JSON.stringify(models),
    enable: 1,
  });
}

function installLocalVendorResultSink(): void {
  const productionWriteFile = u.oss.writeFile.bind(u.oss);
  u.oss.writeFile = async (target: string, data: Buffer | string): Promise<void> => {
    if (!path.isAbsolute(target)) return productionWriteFile(target, data);
    const resolved = path.resolve(target);
    const allowedRoot = `${path.resolve(DATA_ROOT)}${path.sep}`.toLowerCase();
    if (!`${resolved}${path.sep}`.toLowerCase().startsWith(allowedRoot)) {
      throw new Error("本地供应商结果路径超出联合门禁目录");
    }
    // 中文注释：仅替换本地 fake 的结果落盘边界，避免触碰供应商网络；真实 HTTP 路由与响应保持生产实现。
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    const buffer = typeof data === "string"
      ? Buffer.from(data.replace(/^data:[^;]+;base64,/, ""), "base64")
      : data;
    await fs.promises.writeFile(resolved, buffer);
  };
}

async function installRecoveryWindow(): Promise<void> {
  // 中文注释：账号投影失败 + 项目补偿删除失败，稳定制造生产 202 恢复窗口。
  await accountDb.raw("DROP TRIGGER IF EXISTS r27_web_http_fail_dispatch");
  await accountDb.raw(`
    CREATE TRIGGER r27_web_http_fail_dispatch
    BEFORE INSERT ON o_dreaminaCliDispatch
    BEGIN SELECT RAISE(ABORT, 'round27 web-http injected dispatch failure'); END
  `);
  await runWithProjectStorage(PROJECT_UUID, async () => {
    await activeDb.raw("DROP TRIGGER IF EXISTS r27_web_http_fail_compensation");
    await activeDb.raw(`
      CREATE TRIGGER r27_web_http_fail_compensation
      BEFORE DELETE ON o_storyboardGenerationTask
      BEGIN SELECT RAISE(ABORT, 'round27 web-http injected compensation failure'); END
    `);
  });
}

async function clearRecoveryWindow(): Promise<void> {
  await accountDb.raw("DROP TRIGGER IF EXISTS r27_web_http_fail_dispatch");
  await runWithProjectStorage(PROJECT_UUID, () =>
    activeDb.raw("DROP TRIGGER IF EXISTS r27_web_http_fail_compensation"));
}

async function main(): Promise<void> {
  // 中文注释：模块先在 app cwd 完成版本/别名加载，再切到 E 盘隔离数据根供 getPath/SQLite 使用。
  process.chdir(DATA_ROOT);
  process.env.NODE_ENV = "prod";
  process.env.NODE_TEST_CONTEXT = "storyboard-web-http-generation-gate-round27";
  process.env.DREAMINA_FAKE_LOG = CLI_LOG;
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof URL
      ? input.toString()
      : typeof input === "string"
        ? input
        : input.url;
    const target = new URL(raw);
    if (target.hostname !== "127.0.0.1" && target.hostname !== "localhost") {
      externalNetworkCallCount += 1;
      throw new Error("联合门禁禁止外部网络请求");
    }
    return nativeFetch(input, init);
  }) as typeof fetch;
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  installLocalVendorResultSink();
  writeReadyCapability();

  let firstShotUuid = "";
  let secondShotUuid = "";
  await runWithUserStorage(IDENTITY, async () => {
    enterUserStorage(IDENTITY);
    await initializeWorkspaceProject(PROJECT_UUID, {
      id: 2790,
      name: "Round27 Web HTTP 联合门禁",
      projectType: "storyboard" as "novel",
      userId: IDENTITY.userId,
    });
    await writeDreaminaCliSettings({
      executablePath: FAKE_CLI,
      maxConcurrency: 1,
      pauseNewClaims: true,
    });
    await installLocalVendor();
    const service = new StoryboardService(PROJECT_UUID);
    // 中文注释：即梦正式预览要求项目提供合法分辨率；联合夹具显式满足生产硬门。
    await service.saveSettings({ resolution: "720p" });
    const first = await service.insertShot({
      afterShotUuid: null,
      sourceText: "霓虹雨夜，主角走入车站",
      visualDescription: "中景，雨幕与霓虹倒影",
    });
    await service.updateShot(first.shotUuid, {
      videoPrompt: "镜头缓慢推进，人物抬头",
      durationMs: 5_000,
      aspectRatio: "16:9",
    });
    const second = await service.insertShot({
      afterShotUuid: first.shotUuid,
      sourceText: "列车驶入站台",
      visualDescription: "广角，列车灯光划过雨幕",
    });
    await service.updateShot(second.shotUuid, {
      videoPrompt: "列车由远及近，镜头保持稳定",
      durationMs: 6_000,
      aspectRatio: "16:9",
    });
    firstShotUuid = first.shotUuid;
    secondShotUuid = second.shotUuid;
  });

  syncCoordinator.listProjects = () => [{
    projectUuid: PROJECT_UUID,
    name: "Round27 Web HTTP 联合门禁",
    kind: "personal",
    ownerUserId: IDENTITY.userId,
    myRole: "owner",
    openMode: "editable",
  }] as never;

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    enterUserStorage(IDENTITY);
    (req as { centralSession?: unknown }).centralSession = {
      serverUrl: IDENTITY.issuer,
      user: { id: IDENTITY.userId, username: "round27-web-http" },
    };
    next();
  });
  app.get("/__test/state", async (_req, res) => {
    try {
      res.status(200).send({ code: 0, data: await readState() });
    } catch (error) {
      res.status(500).send({ code: "TEST_STATE_FAILED", message: String(error) });
    }
  });
  app.post("/__test/recovery-window", async (_req, res) => {
    try {
      await installRecoveryWindow();
      res.status(200).send({ code: 0, data: { installed: true } });
    } catch (error) {
      res.status(500).send({ code: "TEST_TRIGGER_FAILED", message: String(error) });
    }
  });
  app.delete("/__test/recovery-window", async (_req, res) => {
    try {
      await clearRecoveryWindow();
      res.status(200).send({ code: 0, data: { cleared: true } });
    } catch (error) {
      res.status(500).send({ code: "TEST_TRIGGER_CLEAR_FAILED", message: String(error) });
    }
  });
  const { default: runtimeRouter } = await import("../../../src/routes/tianjiang/runtime");
  app.use("/api/tianjiang/runtime", runtimeRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("联合门禁监听失败");
  process.stdout.write(`${JSON.stringify({
    ready: true,
    origin: `http://127.0.0.1:${address.port}`,
    projectUuid: PROJECT_UUID,
    firstShotUuid,
    secondShotUuid,
    vendorModel: LOCAL_VENDOR_MODEL,
    fixtureId: crypto.randomUUID(),
  })}\n`);

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    stopDreaminaSchedulerLoop();
    await clearRecoveryWindow().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.exitCode = 0;
  };
  process.stdin.resume();
  process.stdin.once("end", () => void close());
  process.once("SIGTERM", () => void close());
}

void main().catch(async (error) => {
  stopDreaminaSchedulerLoop();
  await destroyAllDatabaseHandles().catch(() => undefined);
  process.stderr.write(`联合门禁夹具启动失败: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

/**
 * Task 11 RED：第二设备全新根安装、媒体可读、非原设备不提交、原设备恰好一次。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import type { CentralAuthGateway, CentralSession } from "../../src/tianjiang/auth/central-session";
import { getStableDeviceUUID } from "../../src/tianjiang/auth/device";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { writeProjectFileAtomic } from "../../src/tianjiang/media/project-file-store";
import { CentralRuntimeAdapter } from "../../src/tianjiang/runtime/central-runtime-adapter";
import { RuntimeProjectLocal } from "../../src/tianjiang/runtime/project-runtime-local";
import { PersonalProjectSync } from "../../src/tianjiang/sync/personal-project-sync";
import {
  activateUserDatabase,
  accountDb,
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
  db as activeDb,
} from "../../src/utils/db";
import {
  currentUserStorage,
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { installStoryboardCandidate } from "../../src/tianjiang/storyboard/storyboard-generation-service";
import { insertDreaminaDispatch } from "../../src/tianjiang/model-providers/dreamina-cli/task-store";
import { enqueueAsyncMediaTasks } from "../../src/tianjiang/model-providers/async-generation-service";
import { writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import { writeReadyDreaminaTestCapability } from "./helpers/dreamina-capability";
import { aggregateTaskCenterList } from "../../src/tianjiang/tasks/task-center-aggregation";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import getPath from "../../src/utils/getPath";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9802 };
const PROJECT = "11111111-1111-4111-a111-111111111111";
const ASSET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_DEVICE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");

function md5Of(bytes: Buffer): string {
  return crypto.createHash("md5").update(bytes).digest("hex");
}

test("第二设备从全新数据根安装后分镜设置绑定候选和媒体必须可读，且不含账号即梦表", async () => {
  const originRoot = path.resolve(process.cwd(), "..", ".tmp", `sb-dev1-${Date.now()}`);
  const secondRoot = path.resolve(process.cwd(), "..", ".tmp", `sb-dev2-${Date.now()}`);
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  fs.mkdirSync(originRoot, { recursive: true });
  fs.mkdirSync(secondRoot, { recursive: true });
  process.chdir(originRoot);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  try {
    const packed = await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT, {
        id: 82,
        name: "第二设备源",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      const service = new StoryboardService(PROJECT);
      await service.saveSettings({ globalImagePrompt: "胶片颗粒", aspectRatio: "16:9" });
      await runWithProjectStorage(PROJECT, () => activeDb("o_assets").insert({
        id: 1,
        name: "角色甲",
        type: "role",
        describe: "雨巷",
        assetUuid: ASSET,
        projectId: 82,
      }));
      const shot = await service.insertShot({
        afterShotUuid: null,
        sourceText: "雨巷",
        imagePrompt: "夜雨",
      });
      await service.bindAsset(shot.shotUuid, {
        sourceProjectUuid: PROJECT,
        assetUuid: ASSET,
        assetType: "role",
        relationRole: "appear",
      });
      const segment = currentUserStorage()!.segment;
      const mediaRel = `files/images/storyboard/${shot.shotUuid}/chosen.png`;
      writeProjectFileAtomic(getPath(), PROJECT, segment, mediaRel, Buffer.from("storyboard-media"));
      const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT, name: "第二设备源", kind: "personal", ownerUserId: IDENTITY.userId,
        role: "owner", myRole: "owner", currentVersion: 1, syncState: "synced",
        lastSyncedAt: null, updatedAt: "2026-08-13T00:00:00Z", lockStatus: "none",
        lockHolderName: "", openMode: "editable", businessType: "storyboard",
      }] as any;
      await installStoryboardCandidate({
        projectUuid: PROJECT,
        shotUuid: shot.shotUuid,
        mediaType: "image",
        relativePath: mediaRel,
        select: true,
      });
      syncCoordinator.listProjects = originalList;
      const originDir = projectDirectory(getPath(), PROJECT, segment);
      const mediaBytes = fs.readFileSync(path.join(originDir, ...mediaRel.split("/")));
      const snapshotPath = path.join(originRoot, "origin-snapshot.sqlite");
      const live = new Database(path.join(originDir, "project.sqlite"), { fileMustExist: true });
      await live.backup(snapshotPath);
      live.close();
      const sqliteBytes = fs.readFileSync(snapshotPath);
      return { sqliteBytes, mediaBytes, mediaRel, shotUuid: shot.shotUuid, segment };
    });

    const userSegment = "c".repeat(32);
    const remoteVersion = 7;
    const objects = [
      { relativePath: "project.sqlite", size: packed.sqliteBytes.length, md5: md5Of(packed.sqliteBytes) },
      {
        relativePath: packed.mediaRel,
        size: packed.mediaBytes.length,
        md5: md5Of(packed.mediaBytes),
        mediaType: "image" as const,
      },
    ];
    const session = {
      id: "session",
      serverUrl: "https://api.example.invalid",
      token: "memory-only",
      expiresAt: Date.now() + 60_000,
      validatedAt: Date.now(),
      user: { id: 7, username: "bob", nickname: "Bob" },
    } as CentralSession;
    const gateway = {
      forwardBusinessRequest: async (_s: CentralSession, pathname: string) => {
        if (pathname.endsWith(`/projects/${PROJECT}`)) {
          return { projectUuid: PROJECT, currentVersion: remoteVersion, objects };
        }
        if (pathname.endsWith("/object-authorizations")) {
          return { url: "https://oss.example.invalid/project.sqlite?signature=x" };
        }
        throw new Error(pathname);
      },
    } as unknown as CentralAuthGateway;
    const bodyByPath = new Map<string, Buffer>([
      ["project.sqlite", packed.sqliteBytes],
      [packed.mediaRel, packed.mediaBytes],
    ]);
    let lastAuthPath = "project.sqlite";
    const adapterGateway = {
      forwardBusinessRequest: async (
        _s: CentralSession,
        pathname: string,
        _m: string,
        body?: unknown,
      ) => {
        if (pathname.endsWith(`/projects/${PROJECT}`)) {
          return { projectUuid: PROJECT, currentVersion: remoteVersion, objects };
        }
        if (pathname.endsWith("/object-authorizations")) {
          lastAuthPath = String((body as { relativePath?: string }).relativePath);
          return { url: `https://oss.example.invalid/${encodeURIComponent(lastAuthPath)}?signature=x` };
        }
        throw new Error(pathname);
      },
    } as unknown as CentralAuthGateway;
    const transport = async (input: string | URL | Request) => {
      const url = String(input);
      const match = /https:\/\/oss\.example\.invalid\/([^?]+)/.exec(url);
      const relativePath = decodeURIComponent(match![1]);
      return new Response(Uint8Array.from(bodyByPath.get(relativePath)!), { status: 200 });
    };
    const local = new RuntimeProjectLocal(secondRoot, PROJECT, userSegment);
    const adapter = new CentralRuntimeAdapter(
      adapterGateway,
      session,
      "018f3d6e-2d9e-7b6c-8a9b-1234567890d2",
      transport as typeof fetch,
    );
    const remote = adapter.personalRemote(PROJECT, (snapshot) => {
      local.acceptDownloaded(snapshot);
    }, { currentVersion: remoteVersion, readObject: () => Buffer.alloc(0) });
    const sync = new PersonalProjectSync(local, remote, () => true);
    sync.open();
    await sync.ensureLoaded();
    local.close();
    const installed = projectDirectory(secondRoot, PROJECT, userSegment);
    const mediaPath = path.join(installed, ...packed.mediaRel.split("/"));
    assert.equal(fs.existsSync(mediaPath), true, "第二设备必须能读到候选媒体");
    assert.deepEqual(fs.readFileSync(mediaPath), packed.mediaBytes);
    const db = new Database(path.join(installed, "project.sqlite"), { readonly: true });
    try {
      const shot = db.prepare("SELECT sourceText, imagePrompt FROM o_storyboardShot WHERE shotUuid = ?")
        .get(packed.shotUuid) as { sourceText: string; imagePrompt: string };
      assert.equal(shot.sourceText, "雨巷");
      assert.equal(shot.imagePrompt, "夜雨");
      const settings = db.prepare("SELECT globalImagePrompt FROM o_storyboardWorkspaceSettings WHERE id = 1")
        .get() as { globalImagePrompt: string };
      assert.equal(settings.globalImagePrompt, "胶片颗粒");
      const binding = db.prepare("SELECT assetUuid FROM o_storyboardShotAsset WHERE shotUuid = ?")
        .get(packed.shotUuid) as { assetUuid: string };
      assert.equal(binding.assetUuid, ASSET);
      const candidate = db.prepare("SELECT relativePath, selected FROM o_storyboardCandidate WHERE shotUuid = ?")
        .get(packed.shotUuid) as { relativePath: string; selected: number };
      assert.equal(candidate.relativePath, packed.mediaRel);
      assert.equal(Number(candidate.selected), 1);
      const dreamina = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'o_dreaminaCli%'",
      ).all() as Array<{ name: string }>;
      assert.equal(dreamina.length, 0, `项目库不得出现账号即梦表: ${dreamina.map((row) => row.name).join(",")}`);
    } finally {
      db.close();
    }
  } finally {
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    try { fs.rmSync(originRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(secondRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("非原设备不得领取/提交，任务中心必须显示等待原设备；原设备双 tick 与恢复只提交一次", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-origin-${Date.now()}`);
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalScenario = process.env.DREAMINA_FAKE_SCENARIO;
  const originalLog = process.env.DREAMINA_FAKE_LOG;
  fs.mkdirSync(root, { recursive: true });
  const logFile = path.join(root, "cli.log");
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.NODE_TEST_CONTEXT = "storyboard-second-device-round12";
  process.env.DREAMINA_FAKE_SCENARIO = "immediate";
  process.env.DREAMINA_FAKE_LOG = logFile;
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT, {
        id: 83,
        name: "原设备项目",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      writeReadyDreaminaTestCapability();
      await writeDreaminaCliSettings({ executablePath: FAKE_CLI, maxConcurrency: 1, pauseNewClaims: false });
      const service = new StoryboardService(PROJECT);
      await service.saveSettings({ globalImagePrompt: "原设备", resolution: "2K" });
      const shot = await service.insertShot({ afterShotUuid: null, sourceText: "原设备", imagePrompt: "原设备" });
      const now = Date.now();
      const foreignTask = crypto.randomUUID();
      await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardGenerationTask").insert({
        taskUuid: foreignTask,
        shotUuid: shot.shotUuid,
        parentTaskUuid: null,
        originDeviceUuid: OTHER_DEVICE,
        mediaType: "image",
        providerId: "dreamina-cli",
        providerTaskId: null,
        providerSessionId: null,
        mode: "text2image",
        modelName: "dreamina-cli:text2image",
        parametersJson: JSON.stringify({ prompt: "foreign" }),
        requestDigest: "a".repeat(64),
        status: "queued",
        paidBatchConfirmedAt: null,
        providerCompletedAt: null,
        resultLocatorDigest: null,
        progress: 0,
        errorCode: null,
        errorSummary: null,
        createdAt: now,
        updatedAt: now,
        enqueueReady: 1,
      }));
      await insertDreaminaDispatch({
        taskUuid: foreignTask,
        projectUuid: PROJECT,
        originDeviceUuid: OTHER_DEVICE,
        mediaType: "image",
        modelName: "dreamina-cli:text2image",
        mode: "text2image",
        projectConcurrencyLimit: 1,
        modelConcurrencyLimit: 1,
        createdAt: now,
      });
      const { tickDreaminaScheduler } = await import("../../src/tianjiang/model-providers/dreamina-cli/scheduler");
      const { recoverDreaminaSlots } = await import("../../src/tianjiang/model-providers/dreamina-cli/recovery");
      await tickDreaminaScheduler();
      const foreignLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
      assert.equal(
        foreignLog.split(/\r?\n/).filter((line) => line.includes("\"text2image\"")).length,
        0,
        `非原设备不得提交 CLI，实际 log=${foreignLog}`,
      );
      const foreignDispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid: foreignTask }).first();
      assert.ok(foreignDispatch);
      assert.notEqual(String(foreignDispatch.queueState), "terminal");
      assert.equal(Number(foreignDispatch.slotHeld), 0, "非原设备不得占槽");

      const segment = currentUserStorage()!.segment;
      const listed = aggregateTaskCenterList([{
        projectUuid: PROJECT,
        projectName: "原设备项目",
        legacyProjectId: 83,
        databasePath: path.join(projectDirectory(getPath(), PROJECT, segment), "project.sqlite"),
      }], { page: 1, limit: 20 });
      const foreignRow = listed.data.find((row) =>
        String(row.rowKey).includes(foreignTask) || String(row.relatedObjects ?? "").includes(foreignTask));
      assert.ok(foreignRow, `任务中心必须看到原设备任务，实际 ${JSON.stringify(listed.data)}`);
      assert.equal(foreignRow.state, "等待原设备", `非原设备状态应为等待原设备，实际 ${foreignRow.state}`);

      const [queued] = await enqueueAsyncMediaTasks({
        projectUuid: PROJECT,
        items: [{
          shotUuid: shot.shotUuid,
          mediaType: "image",
          providerModel: "dreamina-cli:text2image",
          mode: "text2image",
        }],
        paidBatchConfirmed: false,
        clientOperationId: crypto.randomUUID(),
      });
      assert.ok(queued?.taskUuid);
      await Promise.all([tickDreaminaScheduler(), tickDreaminaScheduler()]);
      await recoverDreaminaSlots();
      await tickDreaminaScheduler();
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
      const submits = log.split(/\r?\n/).filter((line) => line.includes("\"text2image\""));
      assert.equal(submits.length, 1, `原设备必须恰好提交一次，实际 ${submits.length} log=${log}`);
    });
  } finally {
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalScenario === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
    else process.env.DREAMINA_FAKE_SCENARIO = originalScenario;
    if (originalLog === undefined) delete process.env.DREAMINA_FAKE_LOG;
    else process.env.DREAMINA_FAKE_LOG = originalLog;
    delete process.env.DREAMINA_TEST_EXECUTABLE;
    delete process.env.NODE_TEST_CONTEXT;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

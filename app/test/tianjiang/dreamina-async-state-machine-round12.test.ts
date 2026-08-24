/**
 * Task 10 RED：Ai.Async 入队、原子领取、只提交一次、完成证据与候选安装。
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
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
  db as activeDb,
} from "../../src/utils/db";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { hasPendingMutationJournal } from "../../src/tianjiang/runtime/legacy-mutation-journal";
import { writeDreaminaCliSettings } from "../../src/tianjiang/model-providers/dreamina-cli/session-store";
import {
  withStoryboardPreviewDigest,
  writeReadyDreaminaTestCapability,
} from "./helpers/dreamina-capability";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9701 };
const PROJECT = "11111111-1111-4111-a111-111111111111";
const FAKE_CLI = path.resolve(__dirname, "fixtures", "fake-dreamina-cli.cjs");

async function listen(app: express.Express) {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

async function jsonRequest(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: response.status, body };
}

test("即梦任务必须经 Ai.Async 入队、双 tick 只提交一次并安装候选", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-async-${Date.now()}`);
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalScenario = process.env.DREAMINA_FAKE_SCENARIO;
  const originalLog = process.env.DREAMINA_FAKE_LOG;
  fs.mkdirSync(root, { recursive: true });
  const logFile = path.join(root, "cli.log");
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.DREAMINA_FAKE_SCENARIO = "immediate";
  process.env.DREAMINA_FAKE_LOG = logFile;
  process.env.DREAMINA_TEST_EXECUTABLE = FAKE_CLI;
  resetDatabaseRuntimeForServe();
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT, {
        id: 61, name: "队列项目", projectType: "storyboard" as "novel", userId: IDENTITY.userId,
      });
      // 中文注释：严格 fake CLI 要求图片生成必须带非空提示词与分辨率。
      await new StoryboardService(PROJECT).saveSettings({ globalImagePrompt: "队列图片生成", resolution: "2K" });
      await writeDreaminaCliSettings({ executablePath: FAKE_CLI, maxConcurrency: 1 });
      writeReadyDreaminaTestCapability();
      syncCoordinator.listProjects = () => [{
        projectUuid: PROJECT, name: "队列项目", kind: "personal", ownerUserId: IDENTITY.userId,
        role: "owner", myRole: "owner", currentVersion: 1, syncState: "synced",
        lastSyncedAt: null, updatedAt: "2026-08-13T00:00:00Z", lockStatus: "none",
        lockHolderName: "", openMode: "editable", businessType: "storyboard",
      }] as any;
      const shot = await new StoryboardService(PROJECT).insertShot({ afterShotUuid: null, sourceText: "雨巷" });
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        enterUserStorage(IDENTITY);
        (req as { centralSession?: unknown }).centralSession = {
          serverUrl: IDENTITY.issuer,
          user: { id: IDENTITY.userId, username: "alice" },
        };
        next();
      });
      const { default: runtimeRouter } = await import("../../src/routes/tianjiang/runtime");
      app.use("/api/tianjiang/runtime", runtimeRouter);
      const { server, port } = await listen(app);
      try {
        const generateUrl = `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT}/storyboard/generate`;
        const confirmed = await withStoryboardPreviewDigest(generateUrl, {
          shotUuid: shot.shotUuid,
          mediaType: "image",
          providerModel: "dreamina-cli:text2image",
          mode: "text2image",
        });
        const enqueued = await jsonRequest(
          generateUrl,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(confirmed),
          },
        );
        assert.equal(enqueued.status, 200);
        const journal = await runWithProjectStorage(PROJECT, () => hasPendingMutationJournal(activeDb as any));
        assert.equal(journal, true, "入队必须与 mutation journal 同事务");

        const { tickDreaminaScheduler } = await import("../../src/tianjiang/model-providers/dreamina-cli/scheduler");
        const beforeTick = await accountDb("o_dreaminaCliDispatch").select();
        let tickError = "";
        try {
          await Promise.all([tickDreaminaScheduler(), tickDreaminaScheduler()]);
        } catch (error) {
          tickError = error instanceof Error ? error.message : String(error);
        }
        const afterTick = await accountDb("o_dreaminaCliDispatch").select();
        const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
        const submits = log.split(/\r?\n/).filter((line) => line.includes("\"text2image\""));
        assert.equal(tickError, "", `双 tick 不得抛错: ${tickError}`);
        assert.equal(submits.length, 1, `双 tick 必须只提交一次，实际 ${submits.length} 次`);
        assert.ok(beforeTick.length >= 1, "tick 前必须已有 dispatch");
        assert.ok(afterTick.length >= 1, "tick 后 dispatch 不得丢失");

        const dispatch = await accountDb("o_dreaminaCliDispatch").first();
        assert.ok(dispatch);
        assert.ok(["postprocessing", "terminal"].includes(String(dispatch.queueState)));
        assert.equal(Number(dispatch.slotHeld), 0);
        const candidates = await runWithProjectStorage(PROJECT, () => activeDb("o_storyboardCandidate").select());
        assert.ok(candidates.length > 0, "完成后必须安装候选");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  } finally {
    syncCoordinator.listProjects = originalList;
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalScenario === undefined) delete process.env.DREAMINA_FAKE_SCENARIO;
    else process.env.DREAMINA_FAKE_SCENARIO = originalScenario;
    if (originalLog === undefined) delete process.env.DREAMINA_FAKE_LOG;
    else process.env.DREAMINA_FAKE_LOG = originalLog;
    delete process.env.DREAMINA_TEST_EXECUTABLE;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

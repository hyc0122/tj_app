/**
 * 扫描恢复不得为每个已关闭项目常驻 Knex/SQLite 句柄。
 * 必须走真实 activateUserDatabase + registerProductionGenerationStatusAdapters + 项目 ALS。
 * 禁止直接登记裸 synthetic adapter。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import {
  accountDatabase,
  activateUserDatabase,
  acquireProjectDatabaseLease,
  databaseRuntimeSnapshot,
  destroyAllDatabaseHandles,
  pauseGenerationTaskRecovery,
  projectDatabaseLeaseSnapshot,
  releaseProjectDatabaseLease,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { stopProcessBackgroundTaskSupervisor } from "../../src/tianjiang/tasks/background-task-supervisor";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import {
  runWithUserStorage,
  userStorageSegment,
} from "../../src/tianjiang/runtime/user-storage-context";
import { registerProductionGenerationStatusAdapters } from "../../src/tianjiang/tasks/vendor-status-adapters";
import { registeredGenerationTaskPoller } from "../../src/tianjiang/tasks/generation-task-recovery";
import { runWithProjectStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { getProcessBackgroundTaskSupervisor } from "../../src/tianjiang/tasks/background-task-supervisor";
import { stringifyGenerationCompletionContract, createGenerationCompletionContract } from "../../src/tianjiang/tasks/generation-completion-contract";
import { setGenerationArtifactDownloaderForTests } from "../../src/tianjiang/tasks/generation-artifact-downloader";

function shortFixtureRoot(label: string): string {
  const root = path.join(process.cwd(), "..", ".tmp", `${label}-${process.pid}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return root;
}

const NOW = 2_900_000_000_000;
const ISSUER = "https://api.j11.com.cn";
const USER_ID = 8801;
const FIXTURE_MP4 = path.resolve(__dirname, "fixtures", "minimal-adoptable.mp4");


function projectUuid(index: number): string {
  return `cccccccc-cccc-4ccc-8ccc-${String(index).padStart(12, "0")}`;
}

function writeProjectSqlite(
  dataRoot: string,
  segment: string,
  uuid: string,
  index: number,
): string {
  const dir = projectDirectory(dataRoot, uuid, segment);
  fs.mkdirSync(dir, { recursive: true });
  const databasePath = path.join(dir, "project.sqlite");
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE o_tasks (
      id INTEGER PRIMARY KEY,
      projectId INTEGER,
      state TEXT,
      reason TEXT,
      provider TEXT,
      remoteTaskId TEXT,
      projectUuid TEXT,
      requestDigest TEXT,
      taskClass TEXT,
      relatedObjects TEXT,
      createdAt INTEGER,
      lastPollAt INTEGER,
      generationStatus TEXT,
      manualRetryRequired INTEGER,
      recoveryAttemptedAt INTEGER,
      resultLocator TEXT
    );
    CREATE TABLE o_video (
      id INTEGER PRIMARY KEY,
      filePath TEXT,
      state TEXT,
      errorReason TEXT
    );
  `);
  const related = stringifyGenerationCompletionContract(createGenerationCompletionContract({
    kind: "video",
    mediaType: "video",
    videoId: 1,
    relativePath: `files/videos/p${index}.mp4`,
  }));
  db.prepare(
    `INSERT INTO o_tasks (
      id, projectId, state, provider, remoteTaskId, projectUuid, requestDigest,
      taskClass, relatedObjects, createdAt, generationStatus, manualRetryRequired
    ) VALUES (1, 1, '进行中', 'atlascloud', ?, ?, ?, '视频生成', ?, ?, 'polling', 0)`,
  ).run(`remote-${index}`, uuid, "b".repeat(64), related, NOW - 5_000);
  db.prepare(`INSERT INTO o_video (id, filePath, state) VALUES (1, '', '生成中')`).run();
  db.close();
  return databasePath;
}

function assertSqliteUnlocked(databasePath: string): void {
  const probe = `${databasePath}.lockprobe`;
  fs.renameSync(databasePath, probe);
  fs.renameSync(probe, databasePath);
}

async function registerProductionQueryAdapter(identity: { issuer: string; userId: number }): Promise<void> {
  const mp4 = fs.readFileSync(FIXTURE_MP4);
  setGenerationArtifactDownloaderForTests({
    lookup: async () => ["1.1.1.1"],
    fetch: async () => new Response(mp4, {
      status: 200,
      headers: { "content-type": "video/mp4" },
    }),
  });
  await runWithUserStorage(identity, async () => {
    const database = accountDatabase();
    await database("o_vendorConfig").where("id", "atlascloud").update({
      enable: 1,
      inputValues: JSON.stringify({
        mediaBaseUrl: "https://provider.example",
        apiKey: "backend-only",
      }),
    });
    await registerProductionGenerationStatusAdapters(database, {
      accountConfigDatabase: database,
      codeLoader: () => "",
      trustedFetch: (async () => new Response(JSON.stringify({
        status: "succeeded",
        url: "https://media.example/generated.mp4",
        content_type: "video/mp4",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    });
  });
}

test("activateUserDatabase 扫描 20 个项目不得常驻句柄；完成后产物落库且文件未锁", async () => {
  const root = shortFixtureRoot("h20");
  const originalCwd = process.cwd();
  const identity = { issuer: ISSUER, userId: USER_ID };
  const segment = userStorageSegment(identity);
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    const dataRoot = path.join(root, "data");
    fs.mkdirSync(dataRoot, { recursive: true });
    const paths: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      paths.push(writeProjectSqlite(dataRoot, segment, projectUuid(index), index));
    }

    await activateUserDatabase(identity);
    await registerProductionQueryAdapter(identity);

    const afterScan = databaseRuntimeSnapshot();
    assert.equal(
      afterScan.projectHandleCount,
      0,
      "扫描恢复只能保存 databasePath，不得为 20 个项目保留 Knex 句柄",
    );

    const probe = await runWithUserStorage(identity, () => runWithProjectStorage(
      projectUuid(0),
      () => registeredGenerationTaskPoller.poll({
        provider: "atlascloud",
        remoteTaskId: "remote-0",
        projectUuid: projectUuid(0),
        requestDigest: "b".repeat(64),
      }),
    ));
    assert.equal(probe.state, "completed", `生产适配器探测失败: ${JSON.stringify(probe)}`);
    assert.ok(probe.artifact?.remoteUrl);

    const supervisor = getProcessBackgroundTaskSupervisor();
    assert.ok(supervisor, "生产入口必须挂上后台监督器");
    await supervisor!.tick(NOW);

    const afterTick = databaseRuntimeSnapshot();
    assert.equal(afterTick.projectHandleCount, 0, "全部后台任务完成后必须释放非活动项目句柄");

    for (let index = 0; index < 20; index += 1) {
      const sqlite = new Database(paths[index], { readonly: true, fileMustExist: true });
      try {
        const video = sqlite.prepare("SELECT state, filePath FROM o_video WHERE id = 1").get() as {
          state: string;
          filePath: string;
        };
        const task = sqlite.prepare("SELECT state, generationStatus, reason FROM o_tasks WHERE id = 1").get() as {
          state: string;
          generationStatus: string;
          reason: string | null;
        };
        assert.equal(task.state, "已完成", `项目 ${index} 任务应完成 status=${task.generationStatus} reason=${task.reason}`);
        assert.equal(video.state, "生成成功", `项目 ${index} 必须写入视频业务产物`);
        assert.ok(video.filePath, `项目 ${index} 缺少产物路径`);
      } finally {
        sqlite.close();
      }
      assertSqliteUnlocked(paths[index]);
    }
  } finally {
    setGenerationArtifactDownloaderForTests(null);
    await pauseGenerationTaskRecovery().catch(() => undefined);
    await stopProcessBackgroundTaskSupervisor().catch(() => undefined);
    await Promise.race([
      destroyAllDatabaseHandles(),
      new Promise((resolve) => setTimeout(resolve, 8_000)),
    ]).catch(() => undefined);
    process.chdir(originalCwd);
  }
});

test("只有活动项目可以在任务完成后继续持有项目句柄", async () => {
  const root = shortFixtureRoot("hact");
  const originalCwd = process.cwd();
  const identity = { issuer: ISSUER, userId: USER_ID + 1 };
  const segment = userStorageSegment(identity);
  const activeUuid = projectUuid(0);
  const idleUuid = projectUuid(1);
  try {
    process.chdir(root);
    resetDatabaseRuntimeForServe();
    const dataRoot = path.join(root, "data");
    fs.mkdirSync(dataRoot, { recursive: true });
    writeProjectSqlite(dataRoot, segment, idleUuid, 1);
    await activateUserDatabase(identity);
    await registerProductionQueryAdapter(identity);
    assert.equal(databaseRuntimeSnapshot().projectHandleCount, 0, "扫描后应无项目句柄");

    await runWithUserStorage(identity, () => acquireProjectDatabaseLease(activeUuid, "ui"));
    assert.equal(databaseRuntimeSnapshot().projectHandleCount, 1, "活动项目可以持有句柄");

    const supervisor = getProcessBackgroundTaskSupervisor();
    await supervisor!.tick(NOW);
    const afterTick = databaseRuntimeSnapshot().projectHandleCount;
    assert.equal(afterTick, 1, `最后一个后台任务完成后只保留活动项目句柄，实际=${afterTick}`);
    await runWithUserStorage(identity, () => {
      assert.equal(projectDatabaseLeaseSnapshot(activeUuid).ui, 1);
    });
  } finally {
    setGenerationArtifactDownloaderForTests(null);
    void pauseGenerationTaskRecovery();
    void stopProcessBackgroundTaskSupervisor();
    void destroyAllDatabaseHandles();
    process.chdir(originalCwd);
  }
});

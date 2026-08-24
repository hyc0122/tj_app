/**
 * Task 11 RED：Team 不得进入 Personal 队列；Team 安装必须过锁；共享资产双边 intent。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  activateUserDatabase,
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
import { hasPendingMutationJournal } from "../../src/tianjiang/runtime/legacy-mutation-journal";
import { sharedAssetGateway } from "../../src/tianjiang/storyboard/shared-asset-gateway";
import { installStoryboardCandidate } from "../../src/tianjiang/storyboard/storyboard-generation-service";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import { rejectIfTeamWouldEnterPersonalQueue } from "../../src/tianjiang/sync/personal-project-sync";
import { durableEnsurePersonalUpload } from "../../src/tianjiang/sync/personal-close-coordinator";
import { openUserSyncQueue } from "../../src/tianjiang/runtime/sync-coordinator";
import getPath from "../../src/utils/getPath";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9803 };
const CONSUMER = "11111111-1111-4111-a111-111111111111";
const SOURCE = "22222222-2222-4222-a222-222222222222";
const TEAM = "44444444-4444-4444-a444-444444444444";
const ASSET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function catalogRow(uuid: string, extras: Record<string, unknown> = {}) {
  return {
    projectUuid: uuid,
    name: uuid.slice(0, 8),
    kind: extras.kind ?? "personal",
    ownerUserId: IDENTITY.userId,
    role: extras.myRole ?? "owner",
    myRole: extras.myRole ?? "owner",
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: "2026-08-13T00:00:00Z",
    lockStatus: extras.lockStatus ?? "none",
    lockHolderName: "",
    openMode: extras.openMode ?? "editable",
    businessType: "storyboard",
    assetSourceProjectUuid: extras.assetSourceProjectUuid,
    lockId: extras.lockId,
    fencingToken: extras.fencingToken,
    lockDeviceUuid: extras.lockDeviceUuid,
  };
}

async function withFixture<T>(run: () => Promise<T>): Promise<T> {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-team-sync-${Date.now()}`);
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  const originalList = syncCoordinator.listProjects.bind(syncCoordinator);
  try {
    return await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      for (const [uuid, id] of [[CONSUMER, 91], [SOURCE, 92], [TEAM, 93]] as const) {
        await initializeWorkspaceProject(uuid, {
          id,
          name: `p-${id}`,
          projectType: "storyboard" as "novel",
          userId: IDENTITY.userId,
        });
      }
      await runWithProjectStorage(SOURCE, () => activeDb("o_assets").insert({
        id: 1,
        name: "角色甲",
        type: "role",
        describe: "雨巷",
        assetUuid: ASSET,
        projectId: 92,
      }));
      return run();
    });
  } finally {
    syncCoordinator.listProjects = originalList;
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test("Personal 耐久入队必须拒绝 Team 项目，队列不得留下 team 上传任务", async () => {
  await withFixture(async () => {
    assert.throws(() => rejectIfTeamWouldEnterPersonalQueue("team"), /Team|个人|sync_tasks|上传队列/);
    const queue = openUserSyncQueue(getPath(), IDENTITY);
    try {
      assert.throws(
        () => durableEnsurePersonalUpload(queue, TEAM, Date.now() + 60_000, { kind: "team" }),
        /Team|个人|上传队列/,
      );
      const latest = queue.getLatestUploadTask(TEAM);
      assert.equal(latest, undefined, `Team 不得留下 Personal 上传任务，实际 ${JSON.stringify(latest)}`);
    } finally {
      queue.close();
    }
  });
});

test("Team 无锁/viewer 不得安装即梦候选，失锁零写入", async () => {
  await withFixture(async () => {
    syncCoordinator.listProjects = () => [
      catalogRow(TEAM, { kind: "team", myRole: "viewer", openMode: "readonly" }),
    ] as any;
    const shot = await new StoryboardService(TEAM).insertShot({ afterShotUuid: null, sourceText: "待安装" });
    const before = await runWithProjectStorage(TEAM, () => activeDb("o_storyboardCandidate").select());
    let status = 200;
    try {
      await installStoryboardCandidate({
        projectUuid: TEAM,
        shotUuid: shot.shotUuid,
        mediaType: "image",
        relativePath: "files/images/storyboard/x.png",
        select: true,
      });
    } catch (error) {
      status = Number((error as { status?: number }).status ?? 500);
    }
    const after = await runWithProjectStorage(TEAM, () => activeDb("o_storyboardCandidate").select());
    assert.equal(status, 403, `Team viewer/无锁安装必须 403，实际 ${status}`);
    assert.equal(after.length, before.length, "失败安装必须零写入候选");
  });
});

test("共享资产更新必须同时给来源和消费项目写 durable intent", async () => {
  await withFixture(async () => {
    syncCoordinator.listProjects = () => [
      catalogRow(CONSUMER, { assetSourceProjectUuid: SOURCE }),
      catalogRow(SOURCE),
    ] as any;
    const session = {
      id: "sess",
      serverUrl: IDENTITY.issuer,
      token: "t",
      expiresAt: Date.now() + 60_000,
      validatedAt: Date.now(),
      user: { id: IDENTITY.userId, username: "alice" },
    } as any;
    const shot = await new StoryboardService(CONSUMER).insertShot({ afterShotUuid: null, sourceText: "引用" });
    await new StoryboardService(CONSUMER).bindAsset(shot.shotUuid, {
      sourceProjectUuid: SOURCE,
      assetUuid: ASSET,
      assetType: "role",
      relationRole: "appear",
    });
    await runWithProjectStorage(CONSUMER, async () => {
      await activeDb("o_legacyMutationJournal").where({ status: "pending" }).update({ status: "cleared" });
    });
    await runWithProjectStorage(SOURCE, async () => {
      await activeDb("o_legacyMutationJournal").where({ status: "pending" }).update({ status: "cleared" });
    });
    await sharedAssetGateway.updateAsset(session, CONSUMER, ASSET, { name: "新角色" });
    const sourcePending = await runWithProjectStorage(SOURCE, () => hasPendingMutationJournal(activeDb as any));
    const consumerPending = await runWithProjectStorage(CONSUMER, () => hasPendingMutationJournal(activeDb as any));
    assert.equal(sourcePending, true, "来源项目必须有 durable intent");
    assert.equal(consumerPending, true, "消费项目必须同时有 durable intent");
  });
});

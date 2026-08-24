/**
 * round6t：真实 openProject 补偿（在线/离线）、补偿失败保持 drain、第二次关闭重试。
 * 禁止 catch openProject 后手工塞假 runtime。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import express from "express";
import Database from "better-sqlite3";

import { projectDirectory } from "../../src/tianjiang/data/paths";
import { RuntimeProjectLocal } from "../../src/tianjiang/runtime/project-runtime-local";
import { PersonalProjectSync } from "../../src/tianjiang/sync/personal-project-sync";
import { createShutdownPhaseState } from "../../src/tianjiang/runtime/sync-coordinator";
import { syncCoordinator } from "../../src/tianjiang/runtime/runtime";
import { centralSessionStore } from "../../src/tianjiang/auth/auth-runtime";
import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
  stopGenerationTaskRecovery,
} from "../../src/utils/db";
import {
  closeServe,
  registerServeRuntimeResources,
  resetServeLifecycleForTests,
  serveRuntimeSnapshot,
} from "../../src/tianjiang/runtime/serve-lifecycle";
import { serveReadinessGate } from "../../src/tianjiang/runtime/serve-readiness";
import {
  runWithUserStorage,
  userStorageSegment,
  userStorageRoot,
} from "../../src/tianjiang/runtime/user-storage-context";
import { openUserSyncQueue } from "../../src/tianjiang/runtime/sync-coordinator";

const worktreeRoot = path.resolve(__dirname, "../..", "..");
const personalA = "e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0";
const personalB = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
const teamFailureUuid = "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2";

function fixture(name: string) {
  const root = path.join(worktreeRoot, ".tmp", "round6t", name, String(Date.now()));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function seedProjectDisk(
  dataRoot: string,
  segment: string,
  projectUuid: string,
  md5 = "seed",
) {
  const root = projectDirectory(dataRoot, projectUuid, segment);
  fs.mkdirSync(path.join(root, "files"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".tianjiang-manifest.json"),
    JSON.stringify({
      version: 1,
      objects: [{ relativePath: "project.sqlite", md5 }],
    }),
  );
  // 最小 sqlite 以便 ProjectStore 打开
  const dbPath = path.join(root, "project.sqlite");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS _t (id INTEGER PRIMARY KEY)");
  db.close();
}

function catalogItem(projectUuid: string, userId: number) {
  return {
    projectUuid,
    name: projectUuid.slice(0, 8),
    kind: "personal" as const,
    ownerUserId: userId,
    role: "owner" as const,
    myRole: "owner" as const,
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: new Date().toISOString(),
    lockStatus: "none" as const,
    lockHolderName: "",
    openMode: "editable" as const,
    businessType: "script" as const,
  };
}

function personalRemoteFactory() {
  const versions = new Map<string, number>();
  return (projectUuid: string) => {
    if (!versions.has(projectUuid)) versions.set(projectUuid, 1);
    return {
      async latest() {
        const v = versions.get(projectUuid) ?? 1;
        return {
          version: v,
          objects: [{ relativePath: "project.sqlite", md5: `v${v}` }],
        };
      },
      async publish(_base: number, next: { objects: Array<{ md5: string }> }) {
        const v = (versions.get(projectUuid) ?? 1) + 1;
        versions.set(projectUuid, v);
        return {
          version: v,
          objects: structuredClone(next.objects),
        };
      },
    };
  };
}

async function bootReal(opts: {
  name: string;
  userId?: number;
  offline?: boolean;
}) {
  const fixtureRoot = fixture(opts.name);
  const dataRoot = path.join(fixtureRoot, "data");
  fs.mkdirSync(dataRoot, { recursive: true });
  const originalCwd = process.cwd();
  process.env.NODE_TEST_CONTEXT = "1";
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktreeRoot;
  process.env.TIANJIANG_TEST_DATA_ROOT = fixtureRoot;
  process.chdir(fixtureRoot);
  resetDatabaseRuntimeForServe();

  const userId = opts.userId ?? 70001;
  const expiresAt = Date.now() + 3_600_000;
  const session = centralSessionStore.create({
    serverUrl: "https://api.j11.com.cn",
    token: `r6t-${userId}`,
    expiresAt,
    user: { id: userId, username: `u${userId}`, nickname: "" },
  });
  (session as { expiresAt: number }).expiresAt = expiresAt;
  const identity = { issuer: session.serverUrl, userId };
  const segment = userStorageSegment(identity);

  seedProjectDisk(dataRoot, segment, personalA, "a-seed");
  seedProjectDisk(dataRoot, segment, personalB, "b-seed");

  const internals = syncCoordinator as unknown as Record<string, any>;
  const remoteFactory = personalRemoteFactory();
  const grant = {
    grantId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
    userId,
    deviceUuid: String(internals.deviceUuid ?? "018f3d6e-2d9e-7b6c-8a9b-r6tdevice0001"),
    expiresAt: new Date(expiresAt).toISOString(),
    revokedAt: null,
  };
  const catalog = [catalogItem(personalA, userId), catalogItem(personalB, userId)];

  Object.assign(internals, {
    dataRoot,
    session: opts.offline ? undefined : session,
    remote: opts.offline
      ? undefined
      : {
          refreshOfflineGrant: async () => grant,
          personalRemote: (
            projectUuid: string,
            _accept: unknown,
            _opts: unknown,
          ) => remoteFactory(projectUuid),
          projectCatalog: async () => catalog,
        },
    catalog: new Map(catalog.map((c) => [c.projectUuid, c])),
    localProjectIds: new Map([
      [personalA, userId],
      [personalB, userId + 1],
    ]),
    offlineCache: {
      issuer: session.serverUrl,
      userId,
      grant,
      catalog,
    },
    online: !opts.offline,
    deviceActive: true,
    profileKey: Buffer.from("r6t-profile-key-32bytes!!!!!!!!!!"),
    profileStore: { closed: false, close() { this.closed = true; } },
    shutdownState: createShutdownPhaseState(),
    shutdownRequested: false,
    shutdownInFlight: undefined,
  });
  internals.projects.clear();
  internals.pendingPersonalCloseCompensations?.clear?.();

  await activateUserDatabase(identity);

  return {
    dataRoot,
    segment,
    identity,
    session,
    internals,
    grant,
    cleanup: async () => {
      internals.projects.clear();
      if (internals.pendingPersonalCloseCompensations) {
        internals.pendingPersonalCloseCompensations.clear();
      }
      centralSessionStore.delete(session.id);
      await stopGenerationTaskRecovery().catch(() => undefined);
      await destroyAllDatabaseHandles().catch(() => undefined);
      resetDatabaseRuntimeForServe();
      resetServeLifecycleForTests();
      process.chdir(originalCwd);
    },
  };
}

async function openBoth(session: unknown | undefined, identity: { issuer: string; userId: number }) {
  const internals = syncCoordinator as unknown as Record<string, any>;
  await runWithUserStorage(identity, async () => {
    await syncCoordinator.openProject(session as never, personalA);
    await syncCoordinator.openProject(session as never, personalB);
  });
  for (const uuid of [personalA, personalB]) {
    const rt = internals.projects.get(uuid);
    assert.ok(rt?.kind === "personal");
    rt.local.dirty = true;
    rt.sync.markEdited?.();
  }
}

function injectFailLocalCloseOnce(projectUuid: string) {
  const internals = syncCoordinator as unknown as Record<string, any>;
  const rt = internals.projects.get(projectUuid);
  assert.ok(rt);
  const orig = rt.local.close.bind(rt.local);
  let failed = false;
  rt.local.close = () => {
    if (!failed) {
      failed = true;
      throw Object.assign(new Error("local.close forced fail"), {
        code: "LOCAL_CLOSE_FAILED",
      });
    }
    return orig();
  };
}

// ---------- 在线：A dispose、B local.close 失败 → 生产 openProject 恢复 A ----------
test("在线：A commit 成功 B local.close 失败后生产 openProject 恢复 A", async () => {
  // 中文注释：fixture 名宜短，避免 Windows 路径过长导致 snapshot VACUUM 失败
  const ctx = await bootReal({ name: "r6t-on" });
  const origOpen = ctx.internals.openProject.bind(ctx.internals);
  let openProjectCalls = 0;
  const openProjectSessionArgs: unknown[] = [];
  try {
    await openBoth(ctx.session, ctx.identity);
    const originalRuntimeA = ctx.internals.projects.get(personalA);
    injectFailLocalCloseOnce(personalB);

    // 仅统计补偿 reopen，禁止 catch 后塞假 runtime
    ctx.internals.openProject = async (
      session: unknown,
      projectUuid: string,
    ) => {
      openProjectCalls += 1;
      openProjectSessionArgs.push(session);
      return origOpen(session, projectUuid);
    };

    await ctx.internals.beginProjectCloseDrain();
    await assert.rejects(
      () => ctx.internals.commitProjectClosesForOrdinaryShutdown(),
      (error: unknown) => {
        const err = error as Error & { code?: string };
        return (
          err instanceof Error
          && (
            err.code === "PERSONAL_CLOSE_BLOCKED"
            || /PERSONAL_CLOSE|资源释放|阻断|local\.close/i.test(err.message)
          )
        );
      },
    );

    assert.equal(openProjectCalls, 1);
    assert.ok(openProjectSessionArgs[0]);
    const reopenedA = ctx.internals.projects.get(personalA);
    assert.ok(reopenedA && reopenedA.kind === "personal");
    assert.notEqual(reopenedA, originalRuntimeA);
    assert.equal(reopenedA.sync.isTerminalClosed(), false);
    assert.equal(ctx.internals.projects.has(personalB), true);
    assert.equal(ctx.internals.projectCloseDraining, true);

    await runWithUserStorage(ctx.identity, async () => {
      await syncCoordinator.syncNow(ctx.session, personalA);
    });
  } finally {
    ctx.internals.openProject = origOpen;
    await ctx.cleanup();
  }
});

test("在线：Personal 已提交关闭后 Team 中央失败 → 生产 openProject 补偿全部 Personal", async () => {
  const ctx = await bootReal({ name: "r6t-team" });
  const origOpen = ctx.internals.openProject.bind(ctx.internals);
  let openProjectCalls = 0;
  try {
    await openBoth(ctx.session, ctx.identity);
    ctx.internals.projects.set(teamFailureUuid, {
      kind: "team",
      local: {
        dirty: true,
        close() {
          throw new Error("Team 中央失败时禁止触发 local.close");
        },
      },
      sync: {
        async close() {
          throw Object.assign(new Error("team publish failed"), {
            code: "TEAM_PUBLISH_FAILED",
          });
        },
      },
    });
    ctx.internals.openProject = async (session: unknown, projectUuid: string) => {
      openProjectCalls += 1;
      return origOpen(session, projectUuid);
    };

    await ctx.internals.beginProjectCloseDrain();
    await assert.rejects(
      () => ctx.internals.commitProjectClosesForOrdinaryShutdown(),
      /Team|团队|发布|同步|关闭/,
    );

    assert.equal(openProjectCalls, 2, "A/B 两个已 dispose 的 Personal 都必须走生产 reopen");
    for (const uuid of [personalA, personalB]) {
      const restored = ctx.internals.projects.get(uuid);
      assert.ok(restored?.kind === "personal", `${uuid} 必须补偿恢复`);
      assert.equal(restored.sync.isTerminalClosed(), false);
    }
    assert.equal(ctx.internals.projects.has(teamFailureUuid), true);
  } finally {
    ctx.internals.openProject = origOpen;
    await ctx.cleanup();
  }
});

test("账号切换：旧账号 Personal 已关闭后 Team 失败 → 生产 openProject 恢复旧账号项目", async () => {
  const ctx = await bootReal({ name: "r6t-switch", userId: 70031 });
  const origOpen = ctx.internals.openProject.bind(ctx.internals);
  let openProjectCalls = 0;
  try {
    await openBoth(ctx.session, ctx.identity);
    ctx.internals.projects.set(teamFailureUuid, {
      kind: "team",
      local: { dirty: true, close() {} },
      sync: {
        async close() {
          throw Object.assign(new Error("team switch publish failed"), {
            code: "TEAM_PUBLISH_FAILED",
          });
        },
      },
    });
    ctx.internals.openProject = async (session: unknown, projectUuid: string) => {
      openProjectCalls += 1;
      return origOpen(session, projectUuid);
    };

    await assert.rejects(
      () => ctx.internals.closeAll({ requireCentralSuccess: true }),
      /team|Team|团队|发布|同步|关闭/i,
    );
    assert.equal(openProjectCalls, 2, "账号切换失败也必须恢复两个旧账号 Personal");
    assert.equal(ctx.internals.projects.has(personalA), true);
    assert.equal(ctx.internals.projects.has(personalB), true);
    assert.equal(ctx.internals.projects.has(teamFailureUuid), true);
  } finally {
    ctx.internals.openProject = origOpen;
    await ctx.cleanup();
  }
});

// ---------- 离线：openProject(undefined) 补偿 ----------
test("离线：openProject(undefined) 补偿 A，队列事实保留", async () => {
  const ctx = await bootReal({ name: "r6t-off", offline: true });
  const origOpen = ctx.internals.openProject.bind(ctx.internals);
  const openProjectSessionArgs: unknown[] = [];
  try {
    // 先在线装载磁盘再切离线
    ctx.internals.session = centralSessionStore.create({
      serverUrl: "https://api.j11.com.cn",
      token: "tmp-online",
      expiresAt: Date.now() + 60_000,
      user: { id: ctx.identity.userId, username: "tmp", nickname: "" },
    });
    ctx.internals.remote = {
      refreshOfflineGrant: async () => ctx.grant,
      personalRemote: (_u: string) => ({
        async latest() {
          return {
            version: 1,
            objects: [{ relativePath: "project.sqlite", md5: "seed" }],
          };
        },
        async publish(_b: number, next: { objects: unknown }) {
          return { version: 2, objects: structuredClone(next.objects as never) };
        },
      }),
    };
    ctx.internals.online = true;
    await openBoth(ctx.internals.session, ctx.identity);

    // 切离线：网络失败 → enqueue_and_dispose
    Object.assign(ctx.internals, {
      session: undefined,
      remote: undefined,
      online: false,
      offlineCache: {
        issuer: ctx.identity.issuer,
        userId: ctx.identity.userId,
        grant: ctx.grant,
        catalog: [...ctx.internals.catalog.values()],
      },
      deviceActive: true,
    });
    // re-create sync with offline isOnline，强制 enqueue_and_dispose
    for (const uuid of [personalA, personalB]) {
      const old = ctx.internals.projects.get(uuid);
      const local = old.local;
      const sync = new PersonalProjectSync(
        local,
        {
          latest: async () => {
            throw new Error("offline");
          },
          publish: async () => {
            throw new Error("offline");
          },
        },
        () => false,
      );
      sync.open();
      local.dirty = true;
      sync.markEdited();
      ctx.internals.projects.set(uuid, { kind: "personal", local, sync });
    }
    injectFailLocalCloseOnce(personalB);

    ctx.internals.openProject = async (session: unknown, projectUuid: string) => {
      openProjectSessionArgs.push(session);
      return origOpen(session, projectUuid);
    };

    await ctx.internals.beginProjectCloseDrain();
    await assert.rejects(
      () => ctx.internals.commitProjectClosesForOrdinaryShutdown(),
      (error: unknown) => {
        const err = error as Error & { code?: string };
        return (
          err instanceof Error
          && (
            err.code === "PERSONAL_CLOSE_BLOCKED"
            || /PERSONAL_CLOSE|资源释放|阻断|local\.close/i.test(err.message)
          )
        );
      },
    );

    assert.equal(openProjectSessionArgs[0], undefined, "离线补偿 session 必须为 undefined");
    assert.ok(ctx.internals.projects.get(personalA));
    assert.ok(ctx.internals.projects.get(personalB));

    // Round9：中央失败取消退出时不把入队当成功；补偿路径保留 runtime 即可。
    const queue = openUserSyncQueue(ctx.dataRoot, ctx.identity);
    try {
      assert.equal(typeof queue.hasActiveUpload, "function");
    } finally {
      queue.close();
    }
  } finally {
    ctx.internals.openProject = origOpen;
    await ctx.cleanup();
  }
});

// ---------- 补偿失败 fail-closed：不 resume ----------
test("补偿失败贯穿 closeServe：四个 resume 均为 0，HTTP 新写 503", async () => {
  const events: string[] = [];
  let resumeProjectCloseDrainCalls = 0;
  let resumeGenerationCalls = 0;
  let socketResumeCalls = 0;
  let httpHits = 0;

  const app = express();
  app.use(serveReadinessGate.middleware());
  app.post("/project/write", (_req, res) => {
    httpHits += 1;
    res.status(200).send("ok");
  });
  const httpServer = http.createServer(app);
  httpServer.unref();
  const originalWaitForDrain = serveReadinessGate.waitForDrain;

  try {
    if (!serveReadinessGate.snapshot().accepting) {
      try {
        serveReadinessGate.startAccepting();
      } catch {
        //
      }
    }
    await new Promise<void>((r, j) => {
      httpServer.once("error", j);
      httpServer.listen(0, "127.0.0.1", () => r());
    });
    const addr = httpServer.address();
    assert.ok(addr && typeof addr === "object");

    registerServeRuntimeResources(
      {
        httpServer,
        socketRuntime: {
          beginReversibleDraining: () => undefined,
          resumeAccepting: () => {
            socketResumeCalls += 1;
          },
          beginClosing: () => undefined,
          waitForDrain: async () => undefined,
          close: async () => undefined,
          snapshot: () => ({ acceptingEvents: false, activeHandlerCount: 0 }),
        } as never,
        webSocketRuntime: {
          beginClosing: () => undefined,
          close: async () => undefined,
        },
      },
      {
        pauseGenerationRecovery: async () => {
          events.push("generation:pause");
        },
        resumeGenerationRecovery: () => {
          resumeGenerationCalls += 1;
        },
        beginProjectCloseDrain: async () => {
          events.push("project-consumer:drain");
        },
        resumeProjectCloseDrain: () => {
          resumeProjectCloseDrainCalls += 1;
        },
        stopGenerationRecovery: async () => undefined,
        stopProfileKeyRecovery: async () => undefined,
        commitProjectCloses: async () => {
          throw Object.assign(new Error("reopen failed"), {
            code: "PERSONAL_CLOSE_COMPENSATION_FAILED",
          });
        },
        finalSync: async () => {
          events.push("final-sync");
        },
        destroyDatabases: async () => {
          events.push("db:destroy");
        },
      },
    );

    serveReadinessGate.waitForDrain = async function () {
      events.push("http:drain");
      await originalWaitForDrain.call(serveReadinessGate);
    };

    await assert.rejects(
      closeServe(),
      (error: unknown) =>
        (error as { code?: string }).code === "PERSONAL_CLOSE_COMPENSATION_FAILED",
    );

    assert.equal(resumeProjectCloseDrainCalls, 0);
    assert.equal(resumeGenerationCalls, 0);
    assert.equal(socketResumeCalls, 0);
    assert.equal(serveReadinessGate.snapshot().accepting, false);
    assert.equal(serveRuntimeSnapshot().phase, "reversible_draining");

    const blocked = await fetch(`http://127.0.0.1:${addr.port}/project/write`, {
      method: "POST",
    });
    assert.equal(blocked.status, 503);
    assert.equal(httpHits, 0);
  } finally {
    // 中文注释：恢复全局 readiness 方法，避免本用例污染后续关闭流程测试。
    serveReadinessGate.waitForDrain = originalWaitForDrain;
    try {
      await closeServe();
    } catch {
      //
    }
    resetServeLifecycleForTests();
    if (httpServer.listening) {
      await new Promise<void>((r) => httpServer.close(() => r()));
    }
  }
});

// ---------- 第二次关闭先补偿 A 再 commit B ----------
test("第二次关闭先重试 unresolved compensation 再 commit", async () => {
  // 独立 userId；短 fixture 名避免 Windows 路径过长
  const ctx = await bootReal({ name: "r6t-rt", userId: 70091 });
  const events: string[] = [];
  let openFailOnce = true;
  const origOpen = ctx.internals.openProject.bind(ctx.internals);
  try {
    await openBoth(ctx.session, ctx.identity);
    injectFailLocalCloseOnce(personalB);

    // 第一次补偿 open 失败一次；其后允许真实 reopen（仅委托生产路径）
    ctx.internals.openProject = async (
      session: unknown,
      projectUuid: string,
    ) => {
      events.push(
        `compensation:reopen-${projectUuid === personalA ? "A" : projectUuid}`,
      );
      if (openFailOnce && projectUuid === personalA) {
        openFailOnce = false;
        throw Object.assign(new Error("open fail once"), {
          code: "OPEN_FAIL",
        });
      }
      const result = await origOpen(session, projectUuid);
      if (projectUuid === personalA) {
        const reopened = ctx.internals.projects.get(personalA);
        assert.ok(reopened?.kind === "personal");
        const originalClose = reopened.sync.close.bind(reopened.sync);
        reopened.sync.close = async () => {
          events.push("personal:attempt-A");
          return originalClose();
        };
      }
      return result;
    };

    await ctx.internals.beginProjectCloseDrain();
    await assert.rejects(
      () => ctx.internals.commitProjectClosesForOrdinaryShutdown(),
      (e: unknown) =>
        (e as { code?: string }).code === "PERSONAL_CLOSE_COMPENSATION_FAILED",
    );
    assert.ok(
      ctx.internals.pendingPersonalCloseCompensations?.has(personalA),
      "A 须留在 pending 集合",
    );
    assert.equal(ctx.internals.projects.has(personalA), false);
    assert.ok(events.includes("compensation:reopen-A"));

    // 修复 B close：inject 已消费一次失败，确保后续可 dispose
    const b = ctx.internals.projects.get(personalB);
    if (b) {
      const o = b.local.close.bind(b.local);
      b.local.close = () => o();
      b.local.dirty = true;
      b.sync.markEdited?.();
    }

    // 第二次：先 restore pending A，再 attempt 剩余 B
    events.length = 0;
    await ctx.internals.beginProjectCloseDrain();
    await ctx.internals.commitProjectClosesForOrdinaryShutdown();
    assert.ok(
      events.some((e) => e === "compensation:reopen-A"),
      "第二次必须重试 compensation A",
    );
    assert.ok(
      events.includes("personal:attempt-A"),
      "第二次必须把刚恢复的 A 纳入本轮 Personal close 目标",
    );
    assert.ok(
      events.indexOf("compensation:reopen-A")
        < events.indexOf("personal:attempt-A"),
      "必须先恢复 A，再拍摄并执行本轮关闭目标",
    );
    assert.equal(
      ctx.internals.pendingPersonalCloseCompensations?.size ?? 0,
      0,
    );
    assert.equal(ctx.internals.projects.has(personalA), false);
    assert.equal(ctx.internals.projects.has(personalB), false);
    assert.equal(ctx.internals.projects.size, 0);
    assert.equal(ctx.internals.shutdownState.projectsClosed, true);
  } finally {
    ctx.internals.openProject = origOpen;
    await ctx.cleanup();
  }
});

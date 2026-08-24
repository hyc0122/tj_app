/**
 * Round10b RED：进度必须经真实 SyncCoordinator 入口，操作级上下文隔离。
 * 禁止手工 bindProgress / store.update；下载阶段不得显示 uploading。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import type { CentralAuthGateway, CentralSession } from "../../src/tianjiang/auth/central-session";
import { MemoryCredentialStore } from "../../src/tianjiang/crypto/credential-store";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { ProjectStore } from "../../src/tianjiang/data/project-store";
import { writeProjectFileAtomic } from "../../src/tianjiang/media/project-file-store";
import { SyncCoordinator } from "../../src/tianjiang/runtime/sync-coordinator";
import {
  reportSyncProgress,
  runWithSyncProgress,
  syncProgressStore,
} from "../../src/tianjiang/runtime/sync-progress";
import { userStorageSegment } from "../../src/tianjiang/runtime/user-storage-context";

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-0000000001c1";
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

const session = {
  id: "sess-prog",
  serverUrl: "https://api.example.invalid",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 81, username: "prog", nickname: "Prog" },
} as CentralSession;

function md5Of(bytes: Buffer): string {
  return crypto.createHash("md5").update(bytes).digest("hex");
}

test("closeProject 生产入口推进 snapshotting→…→completed，含分类计数；无 bindProgress", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-r10b-prog-"));
  const segment = userStorageSegment({ issuer: session.serverUrl, userId: session.user.id });
  const store = new ProjectStore(dataRoot, projectUuid, "readwrite", segment);
  store.setRecord("runtime", "seed", { ok: true });
  store.close();
  const image = Buffer.from("progress-img");
  const video = Buffer.from("progress-vid-bytes");
  writeProjectFileAtomic(dataRoot, projectUuid, segment, "files/images/a.png", image);
  writeProjectFileAtomic(dataRoot, projectUuid, segment, "files/videos/b.mp4", video);
  const root = projectDirectory(dataRoot, projectUuid, segment);
  // 初始 manifest
  const sqlite = fs.readFileSync(path.join(root, "project.sqlite"));
  fs.writeFileSync(path.join(root, ".tianjiang-manifest.json"), JSON.stringify({
    version: 0,
    objects: [],
    installedDatabaseMD5: md5Of(sqlite),
  }));

  const phases: string[] = [];
  const originalUpdate = syncProgressStore.update.bind(syncProgressStore);
  syncProgressStore.update = (partial) => {
    if (partial.phase) phases.push(String(partial.phase));
    return originalUpdate(partial);
  };

  const putPaths: string[] = [];
  const gateway = {
    forwardBusinessRequest: async (
      _s: CentralSession,
      pathname: string,
      _m: string,
      body: Record<string, unknown> = {},
    ) => {
      if (pathname.endsWith("/upload-sessions")) {
        const objects = body.objects as Array<{ relativePath: string; size: number; md5: string }>;
        return {
          sessionUuid: "018f3d6e-2d9e-7b6c-8a9b-0000000001c9",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          objects: objects.map((o) => ({
            relativePath: o.relativePath,
            size: o.size,
            md5: o.md5,
            objectKey: `staging/${o.relativePath}`,
            verified: false,
          })),
          requiredUploadObjects: objects.map((o) => o.relativePath),
        };
      }
      if (pathname.endsWith("/object-authorizations")) {
        const rel = String(body.relativePath);
        // 用 body contentMd5 回显
        return {
          url: `https://oss.example.invalid/put/${encodeURIComponent(rel)}?s=1`,
          signedHeaders: {
            "Content-Md5": String(body.contentMd5 ?? Buffer.from("00", "hex").toString("base64")),
          },
        };
      }
      if (pathname.endsWith("/objects/confirm")) return {};
      if (pathname.endsWith("/commit")) return { version: 1, manifest: body.manifest, objects: [] };
      if (pathname.endsWith("/fail")) return {};
      if (pathname.includes("/projects/") && !pathname.includes("upload")) {
        return { version: 0, currentVersion: 0, objects: [], records: {} };
      }
      throw new Error(`未预期 ${pathname}`);
    },
  } as unknown as CentralAuthGateway;

  const transport = async (input: string | URL | Request) => {
    const url = String(input);
    const m = /put\/([^?]+)/.exec(url);
    if (m) putPaths.push(decodeURIComponent(m[1]!));
    return new Response(null, { status: 200 });
  };

  const coordinator = new SyncCoordinator(dataRoot, gateway, new MemoryCredentialStore());
  // 注入已登录 + 带 transport 的 adapter
  const { CentralRuntimeAdapter } = await import(
    "../../src/tianjiang/runtime/central-runtime-adapter"
  );
  const adapter = new CentralRuntimeAdapter(gateway, session, "018f3d6e-2d9e-7b6c-8a9b-1234567890c1", transport as typeof fetch);
  adapter.bindIncomingStorage(dataRoot, segment);
  Object.assign(coordinator as unknown as Record<string, unknown>, {
    session,
    online: true,
    deviceActive: true,
    remote: adapter,
    localProjectIds: new Map([[projectUuid, 8101], [projectUuid.toLowerCase(), 8101]]),
    catalog: new Map([
      [
        projectUuid,
        {
          projectUuid,
          name: "进度项目",
          kind: "personal",
          ownerUserId: session.user.id,
          role: "owner",
          myRole: "owner",
          currentVersion: 0,
          syncState: "synced",
          lastSyncedAt: null,
          updatedAt: "",
          lockStatus: "none",
          lockHolderName: "",
          openMode: "editable",
          businessType: "script",
        },
      ],
    ]),
  });
  (coordinator as unknown as { initializeLegacyWorkspace: () => Promise<void> })
    .initializeLegacyWorkspace = async () => undefined;

  syncProgressStore.clear();
  try {
    await coordinator.openProject(session, projectUuid);
    // 标记 dirty
    const runtime = (coordinator as unknown as {
      projects: Map<string, { local: { dirty: boolean; setRecord: (n: string, k: string, v: unknown) => void } }>;
    }).projects.get(projectUuid);
    runtime?.local.setRecord("runtime", "edit", { n: 1 });
    runtime!.local.dirty = true;

    await coordinator.closeProject(session, projectUuid);

    const snap = syncProgressStore.get();
    assert.notEqual(snap.state, "idle", "close 必须驱动真实进度 operation");
    assert.ok(
      phases.some((p) => p.includes("snapshot") || p === "snapshotting"),
      `缺 snapshotting，phases=${phases.join(",")}`,
    );
    assert.ok(
      phases.some((p) => p === "uploading" || p === "upload"),
      `缺 uploading，phases=${phases.join(",")}`,
    );
    assert.ok(
      !phases.includes("uploading") || !phases.some((p) => p === "downloading" && phases.indexOf("uploading") < phases.indexOf("downloading")),
      "下载与上传阶段必须可区分（downloading 不得标成 uploading）",
    );
    // 下载场景单独：此处 close 上传路径
    assert.ok(
      (snap.counts.image ?? 0) + (snap.counts.video ?? 0) + (snap.counts.database ?? 0) >= 1
        || snap.totalObjects >= 1,
      `必须有分类或 totalObjects: ${JSON.stringify(snap.counts)}`,
    );
    assert.ok(putPaths.length >= 1, "必须真实上传");
    // 生产入口不得依赖全局 progressOperationId 字段（允许空字符串弃用字段）
    assert.equal(
      (adapter as unknown as { progressOperationId?: string }).progressOperationId || "",
      "",
      "close 路径不得留下全局 progressOperationId",
    );
  } finally {
    syncProgressStore.update = originalUpdate;
    syncProgressStore.clear();
    try {
      (coordinator as unknown as { projects: Map<string, { local: { close: () => void } }> })
        .projects.forEach((r) => r.local.close());
    } catch { /* ignore */ }
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* Windows lock */ }
  }
});

test("后台 Team checkpoint 不得 fail 正在进行的 logout operationId", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-r10b-prog-iso-"));
  syncProgressStore.clear();
  const logoutOp = "logout-op-1";
  syncProgressStore.begin({
    operationId: logoutOp,
    intent: "logout",
    totalProjects: 2,
  });
  // 模拟后台 checkpoint 错误上报错误 operation
  const { CentralRuntimeAdapter } = await import(
    "../../src/tianjiang/runtime/central-runtime-adapter"
  );
  const adapter = new CentralRuntimeAdapter(
    { forwardBusinessRequest: async () => ({}) } as never,
    session,
    "018f3d6e-2d9e-7b6c-8a9b-1234567890c2",
  );
  // 旧全局 bindProgress 会污染 logout
  if (typeof (adapter as { bindProgress?: (id: string) => void }).bindProgress === "function") {
    (adapter as { bindProgress: (id: string) => void }).bindProgress("team-cp-background");
  }
  try {
    // 若仍用全局 id，report 会改写 logout
    (adapter as unknown as { reportProgress?: (p: Record<string, unknown>) => void })
      .reportProgress?.({ phase: "failed", failedObject: "bg" });
    // 通过 store.fail 模拟 checkpoint 失败写入
    syncProgressStore.fail("team-cp-background", "BG", "background fail");
    const snap = syncProgressStore.get();
    assert.equal(snap.operationId, logoutOp, "后台失败不得覆盖 logout operationId");
    assert.notEqual(snap.state, "failed", "logout operation 不得被后台 fail（预期 RED）");
  } finally {
    syncProgressStore.clear();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("真实后台 auto operation 不得覆盖正在显示的 logout 进度", async () => {
  syncProgressStore.clear();
  let releaseBackground!: () => void;
  const backgroundGate = new Promise<void>((resolve) => {
    releaseBackground = resolve;
  });

  try {
    await runWithSyncProgress(
      {
        operationId: "logout-foreground",
        intent: "logout",
        totalProjects: 2,
      },
      async () => {
        reportSyncProgress({ phase: "validating", totalObjects: 2 });
        const background = runWithSyncProgress(
          {
            operationId: "team-checkpoint-background",
            intent: "auto",
            totalProjects: 1,
            projectUuid,
            projectKind: "team",
          },
          async () => {
            reportSyncProgress({ phase: "uploading", totalObjects: 99 });
            await backgroundGate;
          },
        );

        // 中文注释：让后台 operation 真正进入 begin/report，再核对前台所有权。
        await new Promise<void>((resolve) => setImmediate(resolve));
        const during = syncProgressStore.get();
        assert.equal(during.operationId, "logout-foreground");
        assert.equal(during.intent, "logout");
        assert.equal(during.phase, "validating");
        assert.equal(during.totalObjects, 2);

        releaseBackground();
        await background;
      },
    );
    assert.equal(syncProgressStore.get().operationId, "logout-foreground");
    assert.equal(syncProgressStore.get().state, "succeeded");
  } finally {
    releaseBackground?.();
    syncProgressStore.clear();
  }
});

test("logout 与 app quit 生产入口必须建立 ALS，透传真实阶段事件", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-r10b-prog-entry-"));
  const coordinator = new SyncCoordinator(
    dataRoot,
    { forwardBusinessRequest: async () => ({}) } as never,
    new MemoryCredentialStore(),
  );
  const seen: Array<{ intent: string; phase: string }> = [];
  const originalUpdate = syncProgressStore.update.bind(syncProgressStore);
  syncProgressStore.update = (partial) => {
    if (partial.phase) {
      seen.push({
        intent: syncProgressStore.get().intent,
        phase: String(partial.phase),
      });
    }
    return originalUpdate(partial);
  };

  try {
    // 中文注释：替换实际关闭体，只保留生产入口与 ALS 透传，避免用 store.update 冒充。
    (coordinator as unknown as {
      closeAll: () => Promise<void>;
    }).closeAll = async () => {
      reportSyncProgress({ phase: "uploading", totalObjects: 1 });
    };
    await coordinator.prepareExplicitLogout();
    assert.ok(
      seen.some((item) => item.intent === "logout" && item.phase === "uploading"),
      `logout 未透传真实阶段：${JSON.stringify(seen)}`,
    );

    seen.length = 0;
    (coordinator as unknown as {
      closeAllForOrdinaryShutdown: () => Promise<void>;
    }).closeAllForOrdinaryShutdown = async () => {
      reportSyncProgress({ phase: "committing", totalObjects: 1 });
    };
    await coordinator.commitProjectClosesForOrdinaryShutdown();
    assert.ok(
      seen.some((item) => item.intent === "app_quit" && item.phase === "committing"),
      `app quit 未透传真实阶段：${JSON.stringify(seen)}`,
    );
  } finally {
    syncProgressStore.update = originalUpdate;
    syncProgressStore.clear();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("账号切换关闭旧账号项目时必须建立独立进度上下文", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-r10b-prog-switch-"));
  const coordinator = new SyncCoordinator(
    dataRoot,
    { forwardBusinessRequest: async () => ({}) } as never,
    new MemoryCredentialStore(),
  );
  const nextSession = {
    ...session,
    id: "sess-prog-next",
    user: { ...session.user, id: session.user.id + 1, username: "prog-next" },
  } as CentralSession;
  const seen: Array<{ intent: string; phase: string }> = [];
  const originalUpdate = syncProgressStore.update.bind(syncProgressStore);
  syncProgressStore.update = (partial) => {
    if (partial.phase) {
      seen.push({
        intent: syncProgressStore.get().intent,
        phase: String(partial.phase),
      });
    }
    return originalUpdate(partial);
  };

  try {
    Object.assign(coordinator as unknown as Record<string, unknown>, {
      session,
      online: true,
      projects: new Map([[projectUuid, { kind: "personal" }]]),
    });
    // 中文注释：在旧账号关闭阶段主动停止，避免测试继续进入密钥与网络初始化。
    (coordinator as unknown as { stopBackgroundWork: () => Promise<void> })
      .stopBackgroundWork = async () => undefined;
    (coordinator as unknown as { closeAll: () => Promise<void> }).closeAll = async () => {
      reportSyncProgress({ phase: "uploading", totalObjects: 1 });
      throw new Error("STOP_AFTER_ACCOUNT_SWITCH_PROGRESS");
    };

    await assert.rejects(
      () => coordinator.onLogin(nextSession),
      /STOP_AFTER_ACCOUNT_SWITCH_PROGRESS/,
    );
    assert.ok(
      seen.some((item) => item.intent === "account_switch" && item.phase === "uploading"),
      `账号切换未透传真实阶段：${JSON.stringify(seen)}`,
    );
  } finally {
    syncProgressStore.update = originalUpdate;
    syncProgressStore.clear();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("同账号离线缓存自动登录不得误走账号切换关闭门", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-r10b-prog-same-account-"));
  let localCloseCount = 0;
  let terminalDisposeCount = 0;
  const coordinator = new SyncCoordinator(
    dataRoot,
    {
      forwardBusinessRequest: async () => {
        throw new Error("REACHED_SAME_ACCOUNT_LOGIN_SETUP");
      },
    } as never,
    new MemoryCredentialStore(),
  );

  try {
    Object.assign(coordinator as unknown as Record<string, unknown>, {
      // 中文注释：复现真实冷启动——只有同账号离线缓存与已打开项目，尚无内存中央会话。
      session: undefined,
      offlineCache: {
        issuer: session.serverUrl,
        userId: session.user.id,
        grant: {
          grantId: "018f3d6e-2d9e-7b6c-8a9b-0000000001d1",
          userId: session.user.id,
          deviceUuid: "018f3d6e-2d9e-7b6c-8a9b-0000000001d2",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          revokedAt: null,
        },
        catalog: [],
      },
      projects: new Map([[
        projectUuid,
        {
          kind: "personal",
          local: { close: () => { localCloseCount += 1; } },
          sync: { commitTerminalDispose: () => { terminalDisposeCount += 1; } },
        },
      ]]),
    });
    (coordinator as unknown as { stopBackgroundWork: () => Promise<void> })
      .stopBackgroundWork = async () => undefined;
    (coordinator as unknown as { closeAll: () => Promise<void> }).closeAll = async () => {
      throw new Error("WRONG_SAME_ACCOUNT_CLOSE");
    };

    // 同一用户的新会话应进入在线初始化；若误走账号切换门，会抛 WRONG_SAME_ACCOUNT_CLOSE。
    await assert.rejects(
      () => coordinator.onLogin(session),
      /REACHED_SAME_ACCOUNT_LOGIN_SETUP/,
    );
    assert.equal(localCloseCount, 1, "同账号离线 runtime 必须只释放本地句柄");
    assert.equal(terminalDisposeCount, 1, "同账号离线 Personal 定时任务必须停止");
    assert.equal(
      (coordinator as unknown as { projects: Map<string, unknown> }).projects.size,
      0,
      "同账号在线初始化前必须移除旧离线 runtime，后续由在线路径重新打开",
    );
  } finally {
    await coordinator.shutdown().catch(() => undefined);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("增量上传进入 transfer 阶段时必须把候选总量重置为实际上传总量", async () => {
  syncProgressStore.clear();
  try {
    await runWithSyncProgress(
      {
        operationId: "incremental-progress",
        intent: "manual",
        totalProjects: 1,
      },
      async () => {
        reportSyncProgress({
          phase: "snapshotting",
          totalObjects: 8,
          objectTotal: 8,
          totalBytes: 80_000_000,
        });
        // RED：旧实现按 max 单调合并，无法从完整候选清单切换成真正需要上传的增量清单。
        (reportSyncProgress as (partial: Record<string, unknown>) => void)({
          phase: "uploading",
          resetTransferCounters: true,
          completedObjects: 0,
          totalObjects: 1,
          objectIndex: 0,
          objectTotal: 1,
          uploadedBytes: 0,
          totalBytes: 4096,
        });
        const transfer = syncProgressStore.get();
        assert.equal(transfer.totalObjects, 1);
        assert.equal(transfer.objectTotal, 1);
        assert.equal(transfer.totalBytes, 4096);
        assert.equal(transfer.bytesTotal, 4096);
      },
    );
  } finally {
    syncProgressStore.clear();
  }
});

test("多项目退出进入下一项目时必须重置阶段，已完成项目数不得回退", async () => {
  syncProgressStore.clear();
  try {
    await runWithSyncProgress(
      {
        operationId: "multi-project-progress",
        intent: "app_quit",
        totalProjects: 2,
      },
      async () => {
        reportSyncProgress({
          projectUuid: "project-a",
          phase: "finalizing",
          completedProjects: 1,
          completedObjects: 3,
          totalObjects: 3,
          uploadedBytes: 4096,
          totalBytes: 4096,
        });

        // 中文注释：第二个项目是同一退出 operation 的新阶段，允许从 preparing 重新开始；
        // 但整个 operation 的 completedProjects 必须继续保持单调。
        (reportSyncProgress as (partial: Record<string, unknown>) => void)({
          projectUuid: "project-b",
          phase: "preparing",
          resetProjectPhase: true,
          resetTransferCounters: true,
          completedObjects: 0,
          totalObjects: 0,
          uploadedBytes: 0,
          totalBytes: 0,
        });

        const nextProject = syncProgressStore.get();
        assert.equal(nextProject.projectUuid, "project-b");
        assert.equal(nextProject.phase, "preparing");
        assert.equal(nextProject.completedProjects, 1);
        assert.equal(nextProject.completedObjects, 0);
        assert.equal(nextProject.totalObjects, 0);
        assert.equal(nextProject.uploadedBytes, 0);
        assert.equal(nextProject.totalBytes, 0);
      },
    );
  } finally {
    syncProgressStore.clear();
  }
});

/**
 * Round19 RED：打开项目必须启动账号校准，但本地首屏和缓存 getModelList 不得等待远端 ProfileSync。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import express from "express";

import type { CentralSession } from "../../src/tianjiang/auth/central-session";
import { MemoryCredentialStore } from "../../src/tianjiang/crypto/credential-store";
import { ProfileCrypto } from "../../src/tianjiang/crypto/profile-crypto";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { ProfileStore } from "../../src/tianjiang/data/profile-store";
import { ProjectStore } from "../../src/tianjiang/data/project-store";
import { SyncCoordinator } from "../../src/tianjiang/runtime/sync-coordinator";
import { enterUserStorage, userStorageSegment } from "../../src/tianjiang/runtime/user-storage-context";
import {
  ProfileSync,
  type ProfileRemote,
  type ProfileSnapshot,
} from "../../src/tianjiang/sync/profile-sync";
import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import { closeActivatedWorkspaceRuntime, createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

const personalA = "018f3d6e-2d9e-7b6c-8a9b-000000000191";
const personalB = "018f3d6e-2d9e-7b6c-8a9b-000000000192";
const teamC = "018f3d6e-2d9e-7b6c-8a9b-000000000193";
const userUUID = "123e4567-e89b-42d3-a456-426614174191";
const identity = { issuer: "https://api.j11.com.cn", userId: 1910 };
const DELAY_MS = 800;

const session = {
  id: "sess-r19-open",
  serverUrl: identity.issuer,
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: identity.userId, username: "opener", nickname: "Opener" },
} as CentralSession;

class DelayedProfileRemote implements ProfileRemote {
  current: ProfileSnapshot = {
    version: 4,
    entries: { theme: { value: "plain:dark", sensitive: false } },
  };
  getMetadataCalls = 0;
  getCurrentCalls = 0;
  fail = false;
  delayMs = DELAY_MS;

  async getMetadata() {
    this.getMetadataCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.fail) throw new Error("中央 profile metadata 失败");
    return { version: this.current.version, etag: `profile-v${this.current.version}` };
  }

  async getCurrent(): Promise<ProfileSnapshot> {
    this.getCurrentCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return structuredClone(this.current);
  }

  async commit(): Promise<ProfileSnapshot> {
    throw new Error("本测试不得提交完整快照");
  }
}

async function listen(app: express.Express) {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

function seedProject(dataRoot: string, projectUuid: string): void {
  const segment = userStorageSegment(identity);
  const store = new ProjectStore(dataRoot, projectUuid, "readwrite", segment);
  store.setRecord("runtime", "seed", { ok: true });
  store.close();
  const root = projectDirectory(dataRoot, projectUuid, segment);
  const sqlite = fs.readFileSync(path.join(root, "project.sqlite"));
  fs.writeFileSync(path.join(root, ".tianjiang-manifest.json"), JSON.stringify({
    version: 0,
    objects: [{
      relativePath: "project.sqlite",
      md5: crypto.createHash("md5").update(sqlite).digest("hex"),
      size: sqlite.length,
    }],
    installedDatabaseMD5: crypto.createHash("md5").update(sqlite).digest("hex"),
  }));
}

function catalogItem(projectUuid: string, kind: "personal" | "team", role: "owner" | "viewer") {
  return {
    projectUuid,
    name: projectUuid,
    kind,
    ownerUserId: session.user.id,
    role,
    myRole: role,
    currentVersion: 0,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: "",
    lockStatus: "none" as const,
    lockHolderName: "",
    openMode: role === "viewer" ? "readonly" as const : "editable" as const,
    businessType: "script" as const,
  };
}

test("延迟远端校准时 openProject 与缓存 getModelList 必须 local-first，且不触发即梦 CLI", async () => {
  const dataRoot = createUniqueWorktreeRoot("r19-open-local");
  const originalCwd = process.cwd();
  process.env.NODE_ENV = "prod";
  seedProject(dataRoot, personalA);
  seedProject(dataRoot, personalB);
  seedProject(dataRoot, teamC);
  const profileRemote = new DelayedProfileRemote();
  let cliCalls = 0;
  let downloads = 0;
  const installer = await import("../../src/tianjiang/model-providers/dreamina-cli/managed-installer");
  installer.bindDreaminaInstallTestTransport?.(async () => {
    downloads += 1;
    throw new Error("打开项目不得下载即梦 CLI");
  });
  installer.bindDreaminaCommandRunner?.(async (...args: unknown[]) => {
    cliCalls += 1;
    throw new Error(`打开项目不得探测即梦 CLI: ${String(args[0] ?? "")}`);
  });
  try {
    process.chdir(dataRoot);
    resetDatabaseRuntimeForServe();
    await activateUserDatabase(identity);
    enterUserStorage(identity);
    const store = new ProfileStore(dataRoot, userUUID, new ProfileCrypto(userUUID, crypto.randomBytes(32)));
    store.set("theme", "dark", false);
    store.applyStoredSnapshot(store.exportStoredSnapshot(), 4);
    const profileSync = new ProfileSync(store, profileRemote, () => 0);
    const coordinator = new SyncCoordinator(
      dataRoot,
      { forwardBusinessRequest: async () => { throw new Error("不得走默认 gateway"); } } as never,
      new MemoryCredentialStore(),
    );
    Object.assign(coordinator as unknown as Record<string, unknown>, {
      session,
      online: true,
      deviceActive: true,
      remote: {
        personalRemote: () => ({
          latest: async () => ({ version: 0, objects: [] }),
          publish: async () => { throw new Error("不得发布"); },
        }),
        teamRemote: () => ({
          download: async () => undefined,
          acquire: async () => undefined,
          publish: async () => undefined,
          release: async () => undefined,
          heartbeat: async () => undefined,
          latestVersion: async () => 0,
        }),
        profileRemote: () => profileRemote,
      },
      profileStore: store,
      profileSync,
      catalog: new Map([
        [personalA, catalogItem(personalA, "personal", "owner")],
        [personalB, catalogItem(personalB, "personal", "owner")],
        [teamC, catalogItem(teamC, "team", "viewer")],
      ]),
      localProjectIds: new Map([
        [personalA, 1911],
        [personalB, 1912],
        [teamC, 1913],
      ]),
    });
    (coordinator as unknown as { initializeLegacyWorkspace: () => Promise<void> })
      .initializeLegacyWorkspace = async () => undefined;

    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => {
      enterUserStorage(identity);
      next();
    });
    app.use("/api/modelSelect/getModelList", (await import("../../src/routes/modelSelect/getModelList")).default);
    const { server, port } = await listen(app);
    try {
      const openedAt = Date.now();
      const opened = await Promise.all([
        coordinator.openProject(session, personalA),
        coordinator.openProject(session, personalB),
        coordinator.openProject(session, teamC),
      ]);
      const openMs = Date.now() - openedAt;
      assert.ok(openMs < DELAY_MS / 2, `openProject 不得等待 ${DELAY_MS}ms 校准，实际=${openMs}ms`);
      assert.ok(opened[0], "Personal 必须打开");
      assert.ok(opened[2], "Team viewer 必须打开");
      assert.equal(profileRemote.getMetadataCalls, 1, "同账号三项目只能一次 metadata");
      assert.equal(profileRemote.getCurrentCalls, 0, "版本相同且无 pending 时不得拉 current");

      const listStarted = Date.now();
      const listed = await fetch(`http://127.0.0.1:${port}/api/modelSelect/getModelList`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "image" }),
      });
      const listMs = Date.now() - listStarted;
      assert.ok(listMs < DELAY_MS / 2, `缓存 getModelList 不得等待 ${DELAY_MS}ms 校准，实际=${listMs}ms`);
      assert.equal(listed.status, 200, `本地模型目录必须立即可用，实际=${listed.status}`);
      const firstBody = await listed.json() as {
        data?: { items?: unknown[]; catalogVersion?: number; calibrationState?: string };
      };
      assert.ok((firstBody.data?.items?.length ?? 0) > 0, "校准中本地模型必须仍可见");
      const firstVersion = Number(firstBody.data?.catalogVersion ?? 0);
      assert.ok(
        firstBody.data?.calibrationState === "calibrating" || firstBody.data?.calibrationState === "stale",
        `校准中必须返回 calibrating/stale，实际=${firstBody.data?.calibrationState}`,
      );

      await profileSync.currentReconcile();
      const refreshed = await fetch(`http://127.0.0.1:${port}/api/modelSelect/getModelList`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "image" }),
      });
      const refreshedBody = await refreshed.json() as {
        data?: { catalogVersion?: number; calibrationState?: string; items?: unknown[] };
      };
      assert.ok(
        Number(refreshedBody.data?.catalogVersion ?? 0) >= firstVersion,
        `校准完成后 catalogVersion 必须提升或保持可用，前=${firstVersion} 后=${refreshedBody.data?.catalogVersion}`,
      );
      assert.ok((refreshedBody.data?.items?.length ?? 0) > 0, "校准完成后模型仍可选择");
      assert.equal(cliCalls, 0, `打开项目不得探测即梦 CLI，实际=${cliCalls}`);
      assert.equal(downloads, 0, `打开项目不得下载即梦 CLI，实际=${downloads}`);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 200));
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    profileRemote.fail = true;
    profileRemote.delayMs = 20;
    await coordinator.openProject(session, personalA);
    await (profileSync.currentReconcile() ?? Promise.resolve()).catch(() => undefined);
    const failedApp = express();
    failedApp.use(express.json());
    failedApp.use((_req, _res, next) => {
      enterUserStorage(identity);
      next();
    });
    failedApp.use("/api/modelSelect/getModelList", (await import("../../src/routes/modelSelect/getModelList")).default);
    const failed = await listen(failedApp);
    try {
      const listed = await fetch(`http://127.0.0.1:${failed.port}/api/modelSelect/getModelList`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "image" }),
      });
      assert.equal(listed.status, 200, "校准失败后本地模型仍必须可见");
      const body = await listed.json() as { data?: { items?: unknown[]; calibrationState?: string } };
      assert.ok((body.data?.items?.length ?? 0) > 0, "失败后不得把本地模型清空");
      assert.equal(body.data?.calibrationState, "failed", `失败状态必须暴露，实际=${body.data?.calibrationState}`);
      assert.equal(profileSync.status().state, "failed");
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 200));
      failed.server.closeAllConnections?.();
      await new Promise<void>((resolve) => failed.server.close(() => resolve()));
    }

    for (const runtime of (coordinator as unknown as {
      projects: Map<string, { local: { close(): void } }>;
    }).projects.values()) {
      runtime.local.close();
    }
    store.close();
  } finally {
    installer.bindDreaminaInstallTestTransport?.(undefined);
    await closeActivatedWorkspaceRuntime().catch(() => destroyAllDatabaseHandles());
    process.chdir(originalCwd);
  }
});

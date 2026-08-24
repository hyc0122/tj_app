import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import type { CentralSession } from "../../src/tianjiang/auth/central-session";
import { MemoryCredentialStore } from "../../src/tianjiang/crypto/credential-store";
import { ProfileCrypto } from "../../src/tianjiang/crypto/profile-crypto";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { ProfileStore } from "../../src/tianjiang/data/profile-store";
import { ProjectStore } from "../../src/tianjiang/data/project-store";
import { SyncCoordinator } from "../../src/tianjiang/runtime/sync-coordinator";
import { userStorageSegment } from "../../src/tianjiang/runtime/user-storage-context";
import {
  ProfileSync,
  type ProfileRemote,
  type ProfileSnapshot,
} from "../../src/tianjiang/sync/profile-sync";
import { closeActivatedWorkspaceRuntime, createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

const personalA = "018f3d6e-2d9e-7b6c-8a9b-0000000000a1";
const personalB = "018f3d6e-2d9e-7b6c-8a9b-0000000000a2";
const teamC = "018f3d6e-2d9e-7b6c-8a9b-0000000000c1";

const session = {
  id: "sess-open-profile",
  serverUrl: "https://api.example.invalid",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 71, username: "opener", nickname: "Opener" },
} as CentralSession;

class RecordingProfileRemote implements ProfileRemote {
  current: ProfileSnapshot = {
    version: 3,
    entries: { theme: { value: "plain:dark", sensitive: false } },
  };
  metadataStarts: number[] = [];
  metadataEnds: number[] = [];
  getCurrentCalls = 0;
  failMetadata = false;

  async getMetadata() {
    this.metadataStarts.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 40));
    this.metadataEnds.push(Date.now());
    if (this.failMetadata) throw new Error("中央 profile metadata 失败");
    return { version: this.current.version, etag: `profile-v${this.current.version}` };
  }

  async getCurrent(): Promise<ProfileSnapshot> {
    this.getCurrentCalls += 1;
    return structuredClone(this.current);
  }

  async commit(): Promise<ProfileSnapshot> {
    throw new Error("本测试不得提交完整快照");
  }
}

function seedProject(dataRoot: string, projectUuid: string): void {
  const segment = userStorageSegment({ issuer: session.serverUrl, userId: session.user.id });
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

function catalogItem(
  projectUuid: string,
  kind: "personal" | "team",
  role: "owner" | "viewer",
) {
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

async function bindCoordinator(
  dataRoot: string,
  profileRemote: RecordingProfileRemote,
  timings: { latestStarts: number[]; latestEnds: number[] },
) {
  const store = new ProfileStore(
    dataRoot,
    "123e4567-e89b-42d3-a456-426614174071",
    new ProfileCrypto("123e4567-e89b-42d3-a456-426614174071", crypto.randomBytes(32)),
  );
  store.set("theme", "dark", false);
  store.applyStoredSnapshot(store.exportStoredSnapshot(), 3);
  const profileSync = new ProfileSync(store, profileRemote, () => 0);
  const coordinator = new SyncCoordinator(
    dataRoot,
    { forwardBusinessRequest: async () => { throw new Error("不得走默认 gateway"); } } as never,
    new MemoryCredentialStore(),
  );
  const remote = {
    personalRemote: () => ({
      latest: async () => {
        timings.latestStarts.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 40));
        timings.latestEnds.push(Date.now());
        return { version: 0, objects: [] };
      },
      publish: async () => {
        throw new Error("不得发布");
      },
    }),
    teamRemote: () => ({
      download: async () => {
        timings.latestStarts.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 40));
        timings.latestEnds.push(Date.now());
      },
      acquire: async () => undefined,
      publish: async () => undefined,
      release: async () => undefined,
      heartbeat: async () => undefined,
      latestVersion: async () => 0,
    }),
    profileRemote: () => profileRemote,
  };
  Object.assign(coordinator as unknown as Record<string, unknown>, {
    session,
    online: true,
    deviceActive: true,
    remote,
    profileStore: store,
    profileSync,
    catalog: new Map([
      [personalA, catalogItem(personalA, "personal", "owner")],
      [personalB, catalogItem(personalB, "personal", "owner")],
      [teamC, catalogItem(teamC, "team", "viewer")],
    ]),
    localProjectIds: new Map([
      [personalA, 7101],
      [personalB, 7102],
      [teamC, 7103],
    ]),
  });
  (coordinator as unknown as { initializeLegacyWorkspace: () => Promise<void> })
    .initializeLegacyWorkspace = async () => undefined;
  return { coordinator, store, profileSync };
}

test("打开 Personal、Team 与已有 runtime 都并行启动 project_open 校准", async () => {
  const dataRoot = createUniqueWorktreeRoot("open-profile-paths");
  seedProject(dataRoot, personalA);
  seedProject(dataRoot, personalB);
  seedProject(dataRoot, teamC);
  const profileRemote = new RecordingProfileRemote();
  const timings = { latestStarts: [] as number[], latestEnds: [] as number[] };
  const { coordinator, store, profileSync } = await bindCoordinator(dataRoot, profileRemote, timings);

  await Promise.all([
    coordinator.openProject(session, personalA),
    coordinator.openProject(session, personalB),
    coordinator.openProject(session, teamC),
  ]);
  assert.equal(profileRemote.metadataStarts.length, 1, "同账号并发打开必须 single-flight metadata");
  assert.equal(profileRemote.getCurrentCalls, 0);
  assert.ok(timings.latestStarts.length >= 2, "项目清单校验必须启动");
  assert.ok(
    profileRemote.metadataStarts[0]! <= timings.latestEnds[0]!,
    "profile metadata 必须与项目清单并发启动，不得等项目清单结束",
  );
  assert.ok(
    timings.latestStarts[0]! <= profileRemote.metadataEnds[0]!,
    "项目清单必须与 metadata 并发启动，不得串行等待设置网络",
  );

  await profileSync.currentReconcile();
  const afterWave = profileRemote.metadataStarts.length;
  await coordinator.openProject(session, personalA);
  await profileSync.currentReconcile();
  assert.ok(
    profileRemote.metadataStarts.length > afterWave,
    "已有 runtime 再次打开仍必须启动或复用校准，不得直接跳过",
  );
  assert.equal(store.get("theme"), "dark");
  assert.notEqual(profileSync.status().state, "failed");

  for (const runtime of (coordinator as unknown as {
    projects: Map<string, { local: { close(): void } }>;
  }).projects.values()) {
    runtime.local.close();
  }
  store.close();
  await closeActivatedWorkspaceRuntime();
  try {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }
});

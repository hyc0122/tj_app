import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import type { CentralSession } from "../../src/tianjiang/auth/central-session";
import { MemoryCredentialStore } from "../../src/tianjiang/crypto/credential-store";
import { ProfileCrypto } from "../../src/tianjiang/crypto/profile-crypto";
import { ProfileStore } from "../../src/tianjiang/data/profile-store";
import { ProjectStore } from "../../src/tianjiang/data/project-store";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { SyncCoordinator } from "../../src/tianjiang/runtime/sync-coordinator";
import { userStorageSegment } from "../../src/tianjiang/runtime/user-storage-context";
import {
  ProfileSync,
  type ProfileRemote,
  type ProfileSnapshot,
} from "../../src/tianjiang/sync/profile-sync";
import { closeActivatedWorkspaceRuntime, createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

const projectA = "018f3d6e-2d9e-7b6c-8a9b-0000000000b1";
const projectB = "018f3d6e-2d9e-7b6c-8a9b-0000000000b2";
const projectC = "018f3d6e-2d9e-7b6c-8a9b-0000000000b3";

const session = {
  id: "sess-sf",
  serverUrl: "https://api.example.invalid",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 72, username: "flight", nickname: "Flight" },
} as CentralSession;

class RecordingProfileRemote implements ProfileRemote {
  current: ProfileSnapshot = {
    version: 2,
    entries: { theme: { value: "plain:light", sensitive: false } },
  };
  getMetadataCalls = 0;
  fail = false;

  async getMetadata() {
    this.getMetadataCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (this.fail) throw new Error("校准失败");
    return { version: this.current.version, etag: `profile-v${this.current.version}` };
  }

  async getCurrent(): Promise<ProfileSnapshot> {
    throw new Error("失败路径不得下载完整快照");
  }

  async commit(): Promise<ProfileSnapshot> {
    throw new Error("失败路径不得提交");
  }
}

function seed(dataRoot: string, projectUuid: string): void {
  const segment = userStorageSegment({ issuer: session.serverUrl, userId: session.user.id });
  const store = new ProjectStore(dataRoot, projectUuid, "readwrite", segment);
  store.setRecord("runtime", "seed", { ok: true });
  store.close();
  const root = projectDirectory(dataRoot, projectUuid, segment);
  fs.writeFileSync(path.join(root, ".tianjiang-manifest.json"), JSON.stringify({
    version: 0,
    objects: [],
    installedDatabaseMD5: "0".repeat(32),
  }));
}

test("同账号同时打开三个项目只调用一次 metadata；失败不得标成已同步", async () => {
  const dataRoot = createUniqueWorktreeRoot("profile-single-flight");
  for (const id of [projectA, projectB, projectC]) seed(dataRoot, id);
  const remote = new RecordingProfileRemote();
  remote.fail = true;
  const store = new ProfileStore(
    dataRoot,
    "223e4567-e89b-42d3-a456-426614174072",
    new ProfileCrypto("223e4567-e89b-42d3-a456-426614174072", crypto.randomBytes(32)),
  );
  store.set("theme", "light", false);
  store.applyStoredSnapshot(store.exportStoredSnapshot(), 2);
  const profileSync = new ProfileSync(store, remote, () => 0);
  const coordinator = new SyncCoordinator(
    dataRoot,
    { forwardBusinessRequest: async () => { throw new Error("不得走默认 gateway"); } } as never,
    new MemoryCredentialStore(),
  );
  Object.assign(coordinator as unknown as Record<string, unknown>, {
    session,
    online: true,
    deviceActive: true,
    profileStore: store,
    profileSync,
    remote: {
      personalRemote: () => ({
        latest: async () => ({ version: 0, objects: [] }),
        publish: async () => { throw new Error("不得发布"); },
      }),
    },
    catalog: new Map(
      [projectA, projectB, projectC].map((projectUuid, index) => [
        projectUuid,
        {
          projectUuid,
          name: projectUuid,
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
      ]),
    ),
    localProjectIds: new Map([
      [projectA, 7201],
      [projectB, 7202],
      [projectC, 7203],
    ]),
  });
  (coordinator as unknown as { initializeLegacyWorkspace: () => Promise<void> })
    .initializeLegacyWorkspace = async () => undefined;

  await Promise.all([
    coordinator.openProject(session, projectA),
    coordinator.openProject(session, projectB),
    coordinator.openProject(session, projectC),
  ]);
  await profileSync.currentReconcile();

  assert.equal(remote.getMetadataCalls, 1, "三个项目打开只能复用一个设置校准请求");
  assert.equal(store.get("theme"), "light", "校准失败时本地设置仍可读");
  assert.equal(profileSync.status().state, "failed");
  assert.notEqual(profileSync.status().state, "synced");

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

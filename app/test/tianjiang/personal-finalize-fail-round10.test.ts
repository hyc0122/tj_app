/**
 * Round10：Personal finalize 失败必须返回失败，禁止返回 synced/unchanged。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import type { CentralAuthGateway } from "../../src/tianjiang/auth/central-session";
import { MemoryCredentialStore } from "../../src/tianjiang/crypto/credential-store";
import { SyncCoordinator } from "../../src/tianjiang/runtime/sync-coordinator";
import {
  PersonalProjectSync,
  type PersonalLocal,
  type PersonalManifest,
  type PersonalRemote,
} from "../../src/tianjiang/sync/personal-project-sync";

const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

function manifest(version: number): PersonalManifest {
  return {
    version,
    objects: [{ relativePath: "project.sqlite", md5: "c".repeat(32), size: 8 }],
    capturedMutationGeneration: 3,
  };
}

test("runPersonalSyncAndFinalize finalize 抛错时不得向调用方返回 synced", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-finalize-fail-"));
  const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-0000000000ff";
  const local: PersonalLocal & { dirty: boolean } = {
    current: manifest(1),
    dirty: true,
    install: async (remote) => {
      local.current = structuredClone(remote as PersonalManifest);
    },
    createSnapshot: async () => ({
      ...manifest(1),
      objects: [{ relativePath: "project.sqlite", md5: "d".repeat(32), size: 9 }],
      capturedMutationGeneration: 5,
    }),
    createRecovery: async () => undefined,
  };
  const remote: PersonalRemote = {
    latest: async () => manifest(1),
    publish: async (_base, next) => ({ ...next, version: 2 }),
  };
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();

  const gateway = {
    forwardBusinessRequest: async () => ({}),
  } as unknown as CentralAuthGateway;
  const coordinator = new SyncCoordinator(dataRoot, gateway, new MemoryCredentialStore());
  // 注入 personal runtime：publish 成功后 finalize 因无账号存储上下文失败
  (coordinator as unknown as {
    projects: Map<string, { kind: "personal"; local: typeof local; sync: PersonalProjectSync }>;
  }).projects.set(projectUuid, { kind: "personal", local, sync });

  try {
    await assert.rejects(
      () => coordinator.runPersonalSyncAndFinalize(projectUuid, "manual"),
      /finalize|存储上下文|mutation|禁止/i,
    );
    assert.equal(local.dirty, true, "finalize 失败必须保留 dirty");
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

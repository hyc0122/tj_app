import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PersonalProjectSync,
  type PersonalLocal,
  type PersonalManifest,
} from "../../src/tianjiang/sync/personal-project-sync";
import {
  loadPublishReceipt,
  PersistentSyncRemoteFake,
} from "./helpers/persistent-sync-remote-fake";

const SENTINEL = "RED_EXPECTED:CANVAS_PERSONAL_SYNC";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000c01";

function manifest(version: number): PersonalManifest {
  return {
    version,
    objects: [{ relativePath: "project.sqlite", md5: `db${version}`, size: 16 }],
  };
}

class MemoryLocal implements PersonalLocal {
  current?: PersonalManifest;
  dirty = false;
  async install(remote: PersonalManifest): Promise<void> {
    this.current = structuredClone(remote);
  }
  async createSnapshot(): Promise<PersonalManifest> {
    if (!this.current) throw new Error("project not loaded");
    return structuredClone(this.current);
  }
  async createRecovery(): Promise<void> {}
}

test("个人画布发布成功后必须留下可重启回放的 publish receipt，且不得把本地保存当成云端已同步", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-sync-"));
  const local = new MemoryLocal();
  local.current = {
    version: 1,
    objects: [{ relativePath: "project.sqlite", md5: "local-dirty", size: 16 }],
  };
  local.dirty = true;
  const remote = new PersistentSyncRemoteFake(path.join(dataRoot, "remote"), manifest(1));
  const sync = new PersonalProjectSync(local, remote, () => true);
  (sync as { setPublishReceiptContext?: (input: { dataRoot: string; projectUuid: string }) => void })
    .setPublishReceiptContext?.({ dataRoot, projectUuid: PROJECT_UUID });
  sync.open();
  const result = await sync.sync("manual");
  const receipt = loadPublishReceipt(dataRoot, PROJECT_UUID);
  if (result.state !== "synced" || !receipt?.manifestDigest || receipt.version !== remote.current.version) {
    console.error(SENTINEL);
    assert.equal(result.state, "synced", SENTINEL);
    assert.ok(receipt?.manifestDigest, SENTINEL);
    assert.equal(receipt?.version, remote.current.version, SENTINEL);
  }
});

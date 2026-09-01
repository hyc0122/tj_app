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

const SENTINEL = "RED_EXPECTED:CANVAS_CLOSE_FLUSH";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000c11";

function manifest(version: number): PersonalManifest {
  return {
    version,
    objects: [{ relativePath: "project.sqlite", md5: `close${version}`, size: 16 }],
  };
}

class MemoryLocal implements PersonalLocal {
  current?: PersonalManifest;
  dirty = false;
  closed = false;
  async install(remote: PersonalManifest): Promise<void> {
    this.current = structuredClone(remote);
  }
  async createSnapshot(): Promise<PersonalManifest> {
    if (!this.current) throw new Error("project not loaded");
    return structuredClone(this.current);
  }
  async createRecovery(): Promise<void> {}
  close(): void {
    this.closed = true;
  }
}

test("关闭脏画布必须先 flush 发布并保留 receipt，不得直接销毁未同步副本", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-close-"));
  const local = new MemoryLocal();
  local.current = {
    version: 3,
    objects: [{ relativePath: "project.sqlite", md5: "close-dirty", size: 16 }],
  };
  local.dirty = true;
  const remote = new PersistentSyncRemoteFake(path.join(dataRoot, "remote"), manifest(3));
  const sync = new PersonalProjectSync(local, remote, () => true);
  (sync as { setPublishReceiptContext?: (input: { dataRoot: string; projectUuid: string }) => void })
    .setPublishReceiptContext?.({ dataRoot, projectUuid: PROJECT_UUID });
  sync.open();
  const closed = await sync.close();
  const receipt = loadPublishReceipt(dataRoot, PROJECT_UUID);
  const stillDirty = Boolean((local as { dirty: boolean }).dirty);
  if (closed.state !== "synced" || stillDirty || !receipt?.manifestDigest) {
    console.error(SENTINEL);
    assert.equal(closed.state, "synced", SENTINEL);
    assert.equal(stillDirty, false, SENTINEL);
    assert.ok(receipt?.manifestDigest, SENTINEL);
  }
});

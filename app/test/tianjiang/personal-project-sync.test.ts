import assert from "node:assert/strict";
import test from "node:test";

import {
  PersonalProjectConflictError,
  PersonalProjectSync,
  type PersonalLocal,
  type PersonalManifest,
  type PersonalRemote,
} from "../../src/tianjiang/sync/personal-project-sync";

function manifest(version: number, entries: Array<[string, string]>): PersonalManifest {
  return { version, objects: entries.map(([relativePath, md5]) => ({ relativePath, md5 })) };
}

class FakeLocal implements PersonalLocal {
  current?: PersonalManifest;
  dirty = false;
  downloaded: string[][] = [];
  recoveries: string[] = [];

  async install(remote: PersonalManifest, changedPaths: string[]): Promise<void> {
    this.current = structuredClone(remote);
    this.downloaded.push(changedPaths);
  }
  async createSnapshot(): Promise<PersonalManifest> {
    if (!this.current) throw new Error("project not loaded");
    return structuredClone(this.current);
  }
  async createRecovery(reason: string): Promise<void> {
    this.recoveries.push(reason);
  }
}

class FakeRemote implements PersonalRemote {
  current = manifest(2, [["project.sqlite", "db2"], ["files/a.png", "a1"]]);
  metadataReads = 0;
  publishes: Array<{ base: number; changed: string[]; reason: string }> = [];
  conflict = false;

  async latest(): Promise<PersonalManifest> {
    this.metadataReads += 1;
    return structuredClone(this.current);
  }
  async publish(base: number, next: PersonalManifest, changed: string[], reason: string): Promise<PersonalManifest> {
    if (this.conflict || base !== this.current.version) throw new PersonalProjectConflictError();
    this.publishes.push({ base, changed, reason });
    this.current = { ...structuredClone(next), version: base + 1 };
    return structuredClone(this.current);
  }
}

test("新设备延迟下载完整数据库和素材且相同对象不重复传输", async () => {
  const local = new FakeLocal();
  const remote = new FakeRemote();
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();
  assert.equal(remote.metadataReads, 0);
  await sync.ensureLoaded();
  assert.deepEqual(local.downloaded[0], ["files/a.png", "project.sqlite"]);

  // 内容与远端完全一致时幂等：不制造新版本（重启续传安全）。
  local.dirty = true;
  const unchanged = await sync.sync("manual");
  assert.equal(unchanged.state, "unchanged");
  assert.equal(remote.publishes.length, 0);

  // 本地对象变更后才发布，且仅传输变化路径。
  local.current = manifest(2, [["project.sqlite", "db3"], ["files/a.png", "a1"]]);
  local.dirty = true;
  await sync.sync("manual");
  assert.equal(remote.publishes.length, 1);
  assert.deepEqual(remote.publishes[0].changed, ["project.sqlite"]);
});

test("编辑采用30秒空闲和2分钟检查点，离线可编辑且冲突保留恢复副本", async () => {
  const local = new FakeLocal();
  local.current = manifest(4, [["project.sqlite", "local-db"]]);
  const remote = new FakeRemote();
  remote.current = structuredClone(local.current);
  const scheduled: number[] = [];
  let online = false;
  const sync = new PersonalProjectSync(local, remote, () => online, (_run, delay) => {
    scheduled.push(delay);
    return scheduled.length;
  });
  sync.open();
  sync.markEdited();
  assert.deepEqual(scheduled.sort((a, b) => a - b), [30_000, 120_000]);
  assert.equal((await sync.sync("idle")).state, "offline_pending");

  online = true;
  remote.current = manifest(5, [["project.sqlite", "remote-db"]]);
  await assert.rejects(() => sync.close(), PersonalProjectConflictError);
  assert.deepEqual(local.recoveries, ["remote_version_advanced"]);
  assert.equal(remote.publishes.length, 0);
});

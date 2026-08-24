import assert from "node:assert/strict";
import test from "node:test";

import {
  TeamProjectSync,
  type TeamLocal,
  type TeamRemote,
} from "../../src/tianjiang/sync/team-project-sync";
import type { PersonalManifest } from "../../src/tianjiang/sync/personal-project-sync";

class FakeTeamLocal implements TeamLocal {
  events: string[] = [];
  async install(readonly: boolean): Promise<void> { this.events.push(`install:${readonly}`); }
  async setReadonly(reason: string): Promise<void> { this.events.push(`readonly:${reason}`); }
  async createRecovery(reason: string): Promise<void> { this.events.push(`recovery:${reason}`); }
  async createSnapshot(): Promise<PersonalManifest> {
    this.events.push("snapshot");
    return { version: 3, objects: [{ relativePath: "project.sqlite", md5: "local-db" }] };
  }
}

class FakeTeamRemote implements TeamRemote {
  events: string[] = [];
  lockAvailable = true;
  publishFails = false;
  heartbeatFails = false;
  modelsSeen?: Record<string, string>;
  async acquire(): Promise<{ lockId: string; fencingToken: number; holderName?: string } | undefined> {
    this.events.push("acquire");
    return this.lockAvailable ? { lockId: "lock-1", fencingToken: 9 } : undefined;
  }
  async download(): Promise<void> { this.events.push("download"); }
  async publish(
    _lockId: string,
    _token: number,
    _snapshot: PersonalManifest,
    models: Record<string, string>,
  ): Promise<void> {
    this.events.push("publish");
    this.modelsSeen = models;
    if (this.publishFails) throw new Error("publish failed");
  }
  async release(): Promise<void> { this.events.push("release"); }
  async heartbeat(): Promise<void> {
    this.events.push("heartbeat");
    if (this.heartbeatFails) throw new Error("heartbeat failed");
  }
  async fetchProjectEvidence() {
    // 中文注释：测试桩默认表示中央仍停在发布前版本，允许只读状态下受控重试一次。
    return { version: 0, objects: [] };
  }
}

test("查看者只读，编辑者必须先持锁再下载且仅使用当前编辑者个人模型", async () => {
  const viewerRemote = new FakeTeamRemote();
  const viewerLocal = new FakeTeamLocal();
  const viewer = new TeamProjectSync("viewer", viewerLocal, viewerRemote, () => ({ mine: "viewer-model" }));
  await viewer.open();
  assert.deepEqual(viewerRemote.events, ["download"]);
  assert.equal(viewer.state().editable, false);

  const remote = new FakeTeamRemote();
  const local = new FakeTeamLocal();
  const editor = new TeamProjectSync("editor", local, remote, () => ({ mine: "editor-model" }));
  await editor.open();
  assert.deepEqual(remote.events, ["acquire", "download"]);
  assert.equal(editor.state().editable, true);
  await editor.close();
  assert.deepEqual(remote.events, ["acquire", "download", "publish", "release"]);
  assert.equal(local.events.includes("snapshot"), true);
  assert.deepEqual(remote.modelsSeen, { mine: "editor-model" });
});

test("锁不可用与断网立即只读并保留恢复，发布失败不提前释放锁", async () => {
  const lockedRemote = new FakeTeamRemote();
  lockedRemote.lockAvailable = false;
  const locked = new TeamProjectSync("owner", new FakeTeamLocal(), lockedRemote, () => ({}));
  await locked.open();
  assert.equal(locked.state().readonlyReason, "locked_by_other");

  const remote = new FakeTeamRemote();
  const local = new FakeTeamLocal();
  const editor = new TeamProjectSync("editor", local, remote, () => ({}));
  await editor.open();
  await editor.onNetworkLost();
  assert.equal(editor.state().editable, false);
  assert.deepEqual(local.events.slice(-2), ["readonly:network_disconnected", "recovery:network_disconnected"]);

  const failingRemote = new FakeTeamRemote();
  failingRemote.publishFails = true;
  const failing = new TeamProjectSync("editor", new FakeTeamLocal(), failingRemote, () => ({}));
  await failing.open();
  await assert.rejects(() => failing.close(), /publish failed/);
  assert.equal(failingRemote.events.includes("release"), false);
});

test("团队锁心跳失败时立即只读并生成恢复副本", async () => {
  const remote = new FakeTeamRemote();
  remote.heartbeatFails = true;
  const local = new FakeTeamLocal();
  let heartbeat: (() => void) | undefined;
  const editor = new TeamProjectSync(
    "editor",
    local,
    remote,
    () => ({}),
    (run) => {
      heartbeat = run;
      return undefined;
    },
    20_000,
  );
  await editor.open();
  assert.ok(heartbeat);
  heartbeat();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(editor.state().editable, false);
  assert.equal(editor.state().readonlyReason, "heartbeat_failed");
  assert.deepEqual(local.events.slice(-2), [
    "readonly:heartbeat_failed",
    "recovery:heartbeat_failed",
  ]);
});

test("最终发布结果不确定后保持只读并恢复心跳，核对中央证据后才允许重试", async () => {
  const remote = new FakeTeamRemote();
  remote.publishFails = true;
  const scheduled: Array<() => void> = [];
  const editor = new TeamProjectSync(
    "editor",
    new FakeTeamLocal(),
    remote,
    () => ({}),
    (run) => {
      scheduled.push(run);
      return undefined;
    },
  );

  await editor.open();
  assert.equal(scheduled.length, 1);
  await assert.rejects(() => editor.close(), /publish failed/);
  assert.equal(editor.state().editable, false, "发布结果不确定时必须立即禁止继续编辑");
  assert.equal(editor.state().readonlyReason, "publishing_evidence_pending");
  assert.equal(scheduled.length, 2, "发布失败后必须重新安排锁心跳");

  remote.publishFails = false;
  await editor.close();
  assert.equal(remote.events.filter((event) => event === "publish").length, 2);
  assert.equal(remote.events.filter((event) => event === "release").length, 1);
});

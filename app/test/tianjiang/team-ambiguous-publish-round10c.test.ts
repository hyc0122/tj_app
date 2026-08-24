/**
 * Round10c RED：Team 同进程 publishing 模糊结果必须先核对中央证据。
 *
 * 关键窗口：中央 publish 可能已经提交，但客户端在收到响应前断线。
 * 此时再次 close 不能直接 re-publish；必须先读取中央版本与对象摘要。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  TeamProjectSync,
  type ProjectEvidence,
  type TeamLocal,
  type TeamRemote,
} from "../../src/tianjiang/sync/team-project-sync";
import type { PersonalManifest } from "../../src/tianjiang/sync/personal-project-sync";

const worktreeRoot = path.resolve(__dirname, "../..", "..");
const userSegment = "c".repeat(32);

function createFixture(name: string): string {
  const root = path.join(
    worktreeRoot,
    ".tmp",
    "round10c-team-ambiguous-publish",
    name,
    `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function createLocal(readonlyReasons: string[]): TeamLocal {
  const snapshot: PersonalManifest = {
    version: 3,
    capturedMutationGeneration: 7,
    objects: [
      {
        relativePath: "project.sqlite",
        md5: "0123456789abcdef0123456789abcdef",
        size: 128,
      },
    ],
  };
  return {
    current: {
      version: 3,
      objects: [{ relativePath: "project.sqlite", md5: "old", size: 64 }],
    },
    dirty: true,
    async install() {},
    async setReadonly(reason) {
      readonlyReasons.push(reason);
    },
    async createRecovery() {},
    async createSnapshot() {
      return structuredClone(snapshot);
    },
  };
}

type Scenario = {
  sync: TeamProjectSync;
  counters: {
    publish: number;
    evidence: number;
    release: number;
  };
  readonlyReasons: string[];
  setEvidence(value: ProjectEvidence | Error): void;
  setPublishMode(value: "commit_then_throw" | "throw_before_commit" | "success"): void;
};

async function createScenario(name: string): Promise<Scenario> {
  const dataRoot = createFixture(name);
  // 中文注释：release receipt 对项目 UUID 做严格校验，测试必须使用真实合法 UUID。
  const projectUuid = "cccccccc-1111-4111-8111-111111111111";
  const readonlyReasons: string[] = [];
  const counters = { publish: 0, evidence: 0, release: 0 };
  const snapshotObjects = [
    {
      relativePath: "project.sqlite",
      md5: "0123456789abcdef0123456789abcdef",
      size: 128,
    },
  ];
  let evidence: ProjectEvidence | Error = {
    version: 3,
    objects: [{ relativePath: "project.sqlite", md5: "old", size: 64 }],
  };
  let publishMode: "commit_then_throw" | "throw_before_commit" | "success" = "commit_then_throw";

  const remote: TeamRemote = {
    async acquire() {
      return { lockId: `LOCK-${name}`, fencingToken: 11, holderName: "editor" };
    },
    async download() {},
    async publish() {
      counters.publish += 1;
      if (publishMode === "commit_then_throw") {
        // 中文注释：模拟中央已提交，但响应在返回客户端前丢失。
        evidence = { version: 4, objects: structuredClone(snapshotObjects) };
        throw new Error("publish response lost");
      }
      if (publishMode === "throw_before_commit") {
        throw new Error("publish failed before commit");
      }
    },
    async release() {
      counters.release += 1;
    },
    async heartbeat() {},
    async fetchProjectEvidence() {
      counters.evidence += 1;
      if (evidence instanceof Error) throw evidence;
      return structuredClone(evidence);
    },
  };

  const sync = new TeamProjectSync(
    "editor",
    createLocal(readonlyReasons),
    remote,
    () => ({}),
  );
  sync.configureReleaseReceiptStore({ dataRoot, userSegment, projectUuid });
  await sync.open();

  return {
    sync,
    counters,
    readonlyReasons,
    setEvidence(value) {
      evidence = value;
    },
    setPublishMode(value) {
      publishMode = value;
    },
  };
}

test("中央已提交但响应丢失：同进程第二次 close 只核对证据并 release，禁止重复 publish", async () => {
  const scenario = await createScenario("commitok");

  await assert.rejects(() => scenario.sync.close(), /response lost/);
  assert.equal(scenario.counters.publish, 1);
  assert.equal(scenario.sync.state().editable, false, "模糊 publishing 状态必须立即只读");
  assert.throws(() => scenario.sync.writeGuard(), /没有有效编辑锁|只读|恢复/i);

  const result = await scenario.sync.close();
  assert.equal(result.state, "released_cleanup_pending");
  assert.equal(scenario.counters.evidence, 1, "重试前必须读取一次中央权威证据");
  assert.equal(scenario.counters.publish, 1, "证据确认已提交后禁止第二次 publish");
  assert.equal(scenario.counters.release, 1);
  assert.ok(
    scenario.readonlyReasons.some((reason) => /publishing/.test(reason)),
    "首次模糊失败必须将本地存储切为 publishing 只读状态",
  );
});

test("中央仍停在 base：同进程重试必须先核对证据，随后才允许一次受控 re-publish", async () => {
  const scenario = await createScenario("baseleft");
  scenario.setPublishMode("throw_before_commit");

  await assert.rejects(() => scenario.sync.close(), /before commit/);
  assert.equal(scenario.sync.state().editable, false);

  scenario.setEvidence({
    version: 3,
    objects: [{ relativePath: "project.sqlite", md5: "old", size: 64 }],
  });
  scenario.setPublishMode("success");
  const result = await scenario.sync.close();

  assert.equal(result.state, "released_cleanup_pending");
  assert.equal(scenario.counters.evidence, 1, "任何 re-publish 前必须先取中央证据");
  assert.equal(scenario.counters.publish, 2, "base 未推进时只允许一次受控重试");
  assert.equal(scenario.counters.release, 1);
});

test("中央证据读取失败：同进程重试 fail-closed，不得 re-publish 或 release", async () => {
  const scenario = await createScenario("evidence");
  scenario.setPublishMode("throw_before_commit");

  await assert.rejects(() => scenario.sync.close(), /before commit/);
  scenario.setEvidence(new Error("central evidence unavailable"));

  const result = await scenario.sync.close();
  assert.equal(result.state, "recovery_required");
  assert.equal(scenario.counters.evidence, 1);
  assert.equal(scenario.counters.publish, 1, "证据不确定时禁止 re-publish");
  assert.equal(scenario.counters.release, 0, "证据不确定时禁止 release");
  assert.equal(scenario.sync.state().editable, false);
  assert.equal(scenario.sync.state().recoveryRequired, true);
});

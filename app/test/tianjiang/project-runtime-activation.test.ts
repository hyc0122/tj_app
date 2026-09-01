import assert from "node:assert/strict";
import test from "node:test";

import { ProjectRuntimeActivationGate } from "../../src/tianjiang/runtime/project-runtime-activation";

const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";

test("每次成功 open 都发放新代次，延迟旧 close 不得关闭新 runtime", async () => {
  const gate = new ProjectRuntimeActivationGate();
  const first = gate.issueOpenGeneration(UUID);
  const staleExpected = gate.captureCloseGeneration(UUID, first);
  const second = gate.issueOpenGeneration(UUID);
  assert.notEqual(second, first);

  await gate.serialize(UUID, async () => {
    const decision = gate.decideClose(UUID, staleExpected);
    assert.equal(decision.stale, true);
  });
  assert.equal(gate.currentGeneration(UUID), second);

  await gate.serialize(UUID, async () => {
    const decision = gate.decideClose(UUID, second);
    assert.equal(decision.stale, false);
    gate.releaseAfterClose(UUID);
  });
  assert.equal(gate.currentGeneration(UUID), 0);
  const replay = gate.decideClose(UUID, second);
  assert.equal(replay.stale, true);
});

test("serialize 完成后 tails.size 必须为 0", async () => {
  const gate = new ProjectRuntimeActivationGate();
  await gate.serialize(UUID, async () => "ok");
  assert.equal(gate.snapshot().tails, 0);
});

test("大量不同项目 open/close 后 generations 与 tails 均不增长", async () => {
  const gate = new ProjectRuntimeActivationGate();
  for (let index = 0; index < 40; index += 1) {
    const uuid = `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, "0")}`;
    const token = await gate.serialize(uuid, async () => gate.issueOpenGeneration(uuid));
    await gate.serialize(uuid, async () => {
      const decision = gate.decideClose(uuid, token);
      assert.equal(decision.stale, false);
      gate.releaseAfterClose(uuid);
    });
  }
  const snap = gate.snapshot();
  assert.equal(snap.generations, 0);
  assert.equal(snap.tails, 0);
  assert.equal(snap.nextToken, 41);
});

test("同 UUID 的 open/close 必须串行，旧 close 等待后仍按原 generation 判定", async () => {
  const gate = new ProjectRuntimeActivationGate();
  gate.issueOpenGeneration(UUID);
  const expected = gate.captureCloseGeneration(UUID);
  const openStarted = gate.serialize(UUID, async () => gate.issueOpenGeneration(UUID));
  const closeStarted = gate.serialize(UUID, async () => gate.decideClose(UUID, expected));
  const openGen = await openStarted;
  const closeDecision = await closeStarted;
  assert.equal(closeDecision.stale, true);
  assert.equal(openGen > expected, true);
  assert.equal(gate.snapshot().tails, 0);
});

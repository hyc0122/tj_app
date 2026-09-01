import assert from "node:assert/strict";
import test from "node:test";

import {
  registerGenerationRuntimeParticipant,
  withGenerationRuntimePaused,
} from "../../src/tianjiang/tasks/generation-runtime-participants";

test("暂停作用域无论成功或失败都必须恢复后台生成运行时", async () => {
  const events: string[] = [];
  const unregister = registerGenerationRuntimeParticipant({
    async pauseNewWorkAndDrainCriticalSection() {
      events.push("pause");
    },
    async resume() {
      events.push("resume");
    },
    async stop() {},
  });

  try {
    const value = await withGenerationRuntimePaused(async () => {
      events.push("success-run");
      return 42;
    });
    assert.equal(value, 42);
    assert.deepEqual(events, ["pause", "success-run", "resume"]);

    events.length = 0;
    await assert.rejects(
      withGenerationRuntimePaused(async () => {
        events.push("failed-run");
        throw new Error("close failed");
      }),
      /close failed/,
    );
    assert.deepEqual(events, ["pause", "failed-run", "resume"]);
  } finally {
    unregister();
  }
});

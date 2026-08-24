import assert from "node:assert/strict";
import test from "node:test";

import {
  beginDatabaseShutdown,
  destroyDatabaseHandleMap,
  prepareUserDatabase,
  resetDatabaseRuntimeForServe,
  stopGenerationTaskRecovery,
  trackGenerationTaskRecovery,
} from "../../src/utils/db";

test("停止恢复轮询必须等待已经开始的恢复任务真正结束", async () => {
  let finishRecovery!: () => void;
  const recovery = trackGenerationTaskRecovery(() => new Promise<void>((resolve) => {
    finishRecovery = resolve;
  }));

  let stopped = false;
  const stopping = stopGenerationTaskRecovery().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);

  finishRecovery();
  await Promise.all([recovery, stopping]);
  assert.equal(stopped, true);
  resetDatabaseRuntimeForServe();
});

test("数据库 destroy 失败时保留句柄，第二次关闭可以继续重试", async () => {
  let attempts = 0;
  const handles = new Map<string, any>([[
    "user",
    {
      ready: Promise.resolve(),
      client: {
        destroy: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("database busy");
        },
      },
    },
  ]]);

  await assert.rejects(() => destroyDatabaseHandleMap(handles), /database busy/);
  assert.equal(handles.has("user"), true);
  await destroyDatabaseHandleMap(handles);
  assert.equal(handles.size, 0);
  assert.equal(attempts, 2);
});

test("关闭状态禁止 prepareUserDatabase 重新创建 SQLite 句柄", async () => {
  beginDatabaseShutdown();
  await assert.rejects(
    () => prepareUserDatabase({ issuer: "https://api.j11.com.cn", userId: 987654321 }),
    /禁止创建新句柄/,
  );
  resetDatabaseRuntimeForServe();
});

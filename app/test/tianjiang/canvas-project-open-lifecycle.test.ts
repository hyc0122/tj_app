/**
 * 打开 personal canvas 不得走影视旧工作区初始化，也不得伪造 o_project。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { runWithProjectStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  db as activeDb,
  initializeWorkspaceProject,
} from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";

const SENTINEL = "RED_EXPECTED:APP_CANVAS_OPEN_LIFECYCLE";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000801";

test("initializeWorkspaceProject 不得把 canvas 写入影视 o_project", async () => {
  await runWithTemporaryAccount("canvas-open-lifecycle", async () => {
    try {
      await initializeWorkspaceProject(PROJECT_UUID, {
        id: 801,
        name: "画布",
        projectType: "canvas" as "novel",
        userId: 7601,
      });
    } catch {
      // GREEN 必须拒绝 canvas，禁止写入 o_project。
    }
    const row = await runWithProjectStorage(PROJECT_UUID, () =>
      activeDb("o_project").where({ id: 801 }).first().catch(() => undefined),
    );
    assert.equal(row, undefined, SENTINEL);
  });
});

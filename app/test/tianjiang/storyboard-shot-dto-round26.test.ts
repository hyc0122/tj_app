/**
 * Round26 RED：分镜详情保存后，列表与更新响应必须完整回传镜头语言字段。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import {
  enterUserStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9626 };
const PROJECT_UUID = "26262626-2626-4626-a626-262626262626";

test("分镜保存与重新列表必须回传景别、运镜、构图和画幅", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `storyboard-shot-dto-r26-${Date.now()}`);
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT_UUID, {
        id: 2626,
        name: "Round26 分镜字段",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      const service = new StoryboardService(PROJECT_UUID);
      const created = await service.insertShot({ afterShotUuid: null, sourceText: "雨夜进入剧场" });
      const updated = await service.updateShot(created.shotUuid, {
        shotSize: "中景",
        cameraMovement: "缓慢推进",
        composition: "三分法",
        aspectRatio: "9:16",
        durationMs: 6000,
      });

      assert.deepEqual(
        {
          shotSize: updated.shotSize,
          cameraMovement: updated.cameraMovement,
          composition: updated.composition,
          aspectRatio: updated.aspectRatio,
          durationMs: updated.durationMs,
        },
        {
          shotSize: "中景",
          cameraMovement: "缓慢推进",
          composition: "三分法",
          aspectRatio: "9:16",
          durationMs: 6000,
        },
      );

      const listed = (await service.listShots())[0];
      assert.ok(listed);
      assert.equal(listed.shotSize, "中景");
      assert.equal(listed.cameraMovement, "缓慢推进");
      assert.equal(listed.composition, "三分法");
      assert.equal(listed.aspectRatio, "9:16");
      assert.deepEqual(listed.candidates, []);
      assert.deepEqual(listed.generationTasks, []);
    });
  } finally {
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放时由 .tmp 后续清理。 */ }
  }
});

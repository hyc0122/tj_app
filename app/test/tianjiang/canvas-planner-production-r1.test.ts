import assert from "node:assert/strict";
import test from "node:test";

import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithProjectStorage } from "../../src/tianjiang/runtime/user-storage-context";
import {
  applyCanvasPlan,
  createCanvasPlan,
  readCanvasPlan,
  setCanvasPlannerAdapterForTests,
} from "../../src/tianjiang/canvas/canvas-plan-service";
import { readCanvasDocument } from "../../src/tianjiang/canvas/canvas-document-service";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";

const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000001101";

test("AI 规划必须采用模型结果、耐久保存节点与连线，并以单事务应用", async () => {
  await runWithTemporaryAccount("canvas-planner-production", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await runWithProjectStorage(PROJECT_UUID, async () => {
      const seen: Array<Record<string, unknown>> = [];
      setCanvasPlannerAdapterForTests(async (input) => {
        seen.push(input as unknown as Record<string, unknown>);
        return {
          title: "春日短片",
          summary: "已规划文案和出图节点",
          nodes: [
            { clientKey: "copy", kind: "text", title: "文案", prompt: "春日庭院" },
            { clientKey: "image", kind: "image_generation", title: "生成画面", prompt: "春日庭院", modelId: "jiasu:imagen-4" },
          ],
          edges: [{ sourceClientKey: "copy", targetClientKey: "image", label: "作为提示词" }],
        };
      });
      try {
      const plan = await createCanvasPlan({
        projectUuid: PROJECT_UUID,
        baseRevision: 0,
        source: "home",
        prompt: "做一个春日庭院短片",
        modelId: "jiasu:gpt-4o",
        attachmentAssetUuids: [],
        referencedNodeUuids: [],
      });
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.modelId, "jiasu:gpt-4o");
      assert.equal(plan.operations.filter((item) => item.type === "addNode").length, 2);
      assert.equal(plan.operations.filter((item) => item.type === "addEdge").length, 1);

      // 中文注释：从数据库重新读取，证明计划不是进程内 Map 临时状态。
      const persisted = await readCanvasPlan(plan.planUuid);
      assert.deepEqual(persisted, plan);

      const saved = await applyCanvasPlan(PROJECT_UUID, plan.planUuid, {
        baseRevision: 0,
        clientMutationId: "018f3d6e-2d9e-7b6c-8a9b-000000001102",
      }) as { revision: number };
      assert.equal(saved.revision, 1);
      const document = await readCanvasDocument(PROJECT_UUID);
      assert.equal(document.document.graph.nodes.length, 2);
      assert.equal(document.document.graph.edges.length, 1);
      } finally {
        setCanvasPlannerAdapterForTests(undefined);
      }
    });
  });
});

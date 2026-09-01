import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import {
  setCanvasExecutionModelResolverForTests,
} from "../../src/tianjiang/canvas/canvas-execution-service";
import {
  setCanvasExecutionWorkerAdapterForTests,
} from "../../src/tianjiang/canvas/canvas-execution-worker";
import { getCanvasOutboxByRun } from "../../src/tianjiang/canvas/canvas-execution-outbox";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import { mountCanvasRuntimeApp, stubOpenedCanvas } from "./helpers/canvas-crash-harness";

const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-00000000f101";
const NODE_UUID = "018f3d6e-2d9e-7b6c-8a9b-00000000f102";

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("收费任务未在时限内由设备 outbox 消费");
}

test("确认单冻结真实模型路由并由原设备 worker 消费一次", async () => {
  await runWithTemporaryAccount("canvas-execution-worker", async () => {
    let stage = "setup";
    try {
    let executions = 0;
    await initializeCanvasWorkspace(PROJECT_UUID);
    stage = "mount";
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      setCanvasExecutionModelResolverForTests(async ({ modelId, mediaType }) => ({
        modelId: modelId || `vendor:${mediaType}-model`,
        providerId: "vendor",
        deploymentKey: modelId || `vendor:${mediaType}-model`,
        credentialSlotId: "vendor",
      }));
      setCanvasExecutionWorkerAdapterForTests(async (input) => {
        executions += 1;
        assert.equal(input.modelId, "vendor:image-model");
        assert.equal(input.providerId, "vendor");
        assert.equal(input.projectUuid, PROJECT_UUID);
      });
      const document = emptyCanvasDocument();
      stage = "save-document";
      document.graph.nodes = [{
        nodeUuid: NODE_UUID,
        kind: "image_generation",
        position: { x: 0, y: 0 },
        zIndex: 1,
        collapsed: false,
        data: { prompt: "春日庭院", modelId: "vendor:image-model" },
      }];
      await fetch(`http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/document`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: 0, clientMutationId: crypto.randomUUID(), document }),
      });
      const previewResponse = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseRevision: 1, nodeUuids: [NODE_UUID] }),
        },
      );
      stage = "read-preview";
      const preview = await previewResponse.json() as {
        data: { confirmationUuid: string; requestDigest: string; items: Array<Record<string, unknown>> };
      };
      assert.equal(previewResponse.status, 200);
      assert.equal(preview.data.items[0]?.providerId, "vendor");
      assert.equal(preview.data.items[0]?.modelId, "vendor:image-model");
      assert.notEqual(preview.data.items[0]?.credentialSlotId, "local-fake");
      assert.notEqual(
        (preview.data.items[0]?.fee as { displayText?: string } | undefined)?.displayText,
        "¥1.00",
        "未接入供应商报价时禁止伪造固定金额",
      );
      assert.equal(
        preview.data.items[0]?.chargeNotice,
        "实际费用以模型服务商结算为准",
      );

      const confirmResponse = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirmationUuid: preview.data.confirmationUuid,
            requestDigest: preview.data.requestDigest,
            baseRevision: 1,
            clientRequestId: crypto.randomUUID(),
          }),
        },
      );
      stage = "read-confirm";
      const receipt = await confirmResponse.json() as { data: { runs: Array<{ runUuid: string }> } };
      const runUuid = receipt.data.runs[0]!.runUuid;
      await waitUntil(async () => {
        stage = "wait-outbox";
        return getCanvasOutboxByRun(PROJECT_UUID, runUuid)?.state === "succeeded";
      });
      assert.equal(executions, 1);
    } finally {
      setCanvasExecutionWorkerAdapterForTests(undefined);
      setCanvasExecutionModelResolverForTests(undefined);
      await close();
    }
    } catch (error) {
      throw new Error(`画布执行测试在 ${stage} 阶段失败`, { cause: error });
    }
  });
});

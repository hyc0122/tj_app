import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import { currentOriginDeviceUuid } from "../../src/tianjiang/canvas/canvas-execution-service";
import { getStableDeviceUUID } from "../../src/tianjiang/auth/device";
import getPath from "../../src/utils/getPath";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import { mountCanvasRuntimeApp, stubOpenedCanvas } from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:APP_CANVAS_EXECUTION_PREVIEW";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000e11";
const NODE_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000e12";
const MUTATION_ID = "018f3d6e-2d9e-7b6c-8a9b-000000000e13";

async function seedGenerationNode(port: number): Promise<void> {
  const document = emptyCanvasDocument();
  document.graph.nodes = [{
    nodeUuid: NODE_UUID,
    kind: "image_generation",
    position: { x: 40, y: 40 },
    zIndex: 1,
    collapsed: false,
    data: { title: "出图", prompt: "春日庭院", modelId: "fake-image" },
  }];
  await fetch(`http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/document`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: 0,
      clientMutationId: MUTATION_ID,
      document,
    }),
  });
}

test("preview 只接受 baseRevision+nodeUuids，收费项必须服务端派生", async () => {
  await runWithTemporaryAccount("canvas-execution-preview", async () => {
    // 中文注释：收费任务的原设备必须是本机稳定设备 UUID，不能由账号 ID 推导。
    assert.equal(currentOriginDeviceUuid(), getStableDeviceUUID(getPath()), SENTINEL);
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      await seedGenerationNode(port);
      const forged = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseRevision: 1,
            nodeUuids: [NODE_UUID],
            modelId: "stolen-model",
            billingPolicy: "none",
          }),
        },
      );
      const forgedBody = await forged.json().catch(() => ({})) as { errorCode?: string; retryable?: boolean };
      const valid = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseRevision: 1,
            nodeUuids: [NODE_UUID],
          }),
        },
      );
      const validBody = await valid.json().catch(() => ({})) as {
        data?: {
          confirmationUuid?: string;
          paidItemCount?: number;
          items?: Array<{ requiresConfirmation?: boolean; billingPolicy?: string; fee?: { amountMinor?: string } }>;
        };
      };
      if (
        forged.status !== 422
        || forgedBody.errorCode !== "CANVAS_EXECUTION_PREVIEW_REQUEST_INVALID"
        || forgedBody.retryable !== false
        || valid.status !== 200
        || !validBody.data?.confirmationUuid
        || Number(validBody.data.paidItemCount) < 1
        || validBody.data.items?.[0]?.requiresConfirmation !== true
      ) {
        console.error(SENTINEL);
        assert.equal(forged.status, 422, SENTINEL);
        assert.equal(forgedBody.errorCode, "CANVAS_EXECUTION_PREVIEW_REQUEST_INVALID", SENTINEL);
        assert.equal(valid.status, 200, SENTINEL);
        assert.equal(Boolean(validBody.data?.confirmationUuid), true, SENTINEL);
      }
      void crypto;
    } finally {
      await close();
    }
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import { mountCanvasRuntimeApp, stubOpenedCanvas } from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:APP_CANVAS_CONFIRMATION_OUTBOX";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000e21";
const NODE_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000e22";
const MUTATION_ID = "018f3d6e-2d9e-7b6c-8a9b-000000000e23";
const CLIENT_REQUEST_ID = "018f3d6e-2d9e-7b6c-8a9b-000000000e24";

test("confirm 必须返回 202 waiting_for_origin_device，同 ID 异摘要冲突", async () => {
  await runWithTemporaryAccount("canvas-confirmation-outbox", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const document = emptyCanvasDocument();
      document.graph.nodes = [{
        nodeUuid: NODE_UUID,
        kind: "image_generation",
        position: { x: 8, y: 8 },
        zIndex: 1,
        collapsed: false,
        data: { title: "出图", prompt: "春日" },
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
      const preview = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseRevision: 1, nodeUuids: [NODE_UUID] }),
        },
      );
      const previewBody = await preview.json().catch(() => ({})) as {
        data?: { confirmationUuid?: string; requestDigest?: string; documentRevision?: number };
      };
      const illegal = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirmationUuid: previewBody.data?.confirmationUuid,
            requestDigest: previewBody.data?.requestDigest,
            baseRevision: 1,
            clientRequestId: CLIENT_REQUEST_ID,
            teamUuid: "018f3d6e-2d9e-7b6c-8a9b-000000000e25",
          }),
        },
      );
      const illegalBody = await illegal.json().catch(() => ({})) as { errorCode?: string; retryable?: boolean };
      // 中文注释：preview 后文档发生变化时，旧确认单必须失效，不能继续创建收费任务。
      (document.graph.nodes[0] as { data?: Record<string, unknown> }).data = {
        title: "出图",
        prompt: "已经修改的春日",
      };
      await fetch(`http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/document`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRevision: 1,
          clientMutationId: "018f3d6e-2d9e-7b6c-8a9b-000000000e26",
          document,
        }),
      });
      const stale = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirmationUuid: previewBody.data?.confirmationUuid,
            requestDigest: previewBody.data?.requestDigest,
            baseRevision: 1,
            clientRequestId: "018f3d6e-2d9e-7b6c-8a9b-000000000e27",
          }),
        },
      );
      const staleBody = await stale.json().catch(() => ({})) as { errorCode?: string };
      const freshPreview = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseRevision: 2, nodeUuids: [NODE_UUID] }),
        },
      );
      const freshPreviewBody = await freshPreview.json().catch(() => ({})) as {
        data?: { confirmationUuid?: string; requestDigest?: string };
      };
      const confirmBody = {
        confirmationUuid: freshPreviewBody.data?.confirmationUuid,
        requestDigest: freshPreviewBody.data?.requestDigest,
        baseRevision: 2,
        clientRequestId: CLIENT_REQUEST_ID,
      };
      const accepted = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(confirmBody),
        },
      );
      const receipt = await accepted.json().catch(() => ({})) as {
        message?: string;
        data?: { runs?: Array<{ state?: string }> };
      };
      const replay = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(confirmBody),
        },
      );
      const conflict = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...confirmBody,
            requestDigest: "a".repeat(64),
            clientRequestId: CLIENT_REQUEST_ID,
          }),
        },
      );
      const conflictBody = await conflict.json().catch(() => ({})) as { errorCode?: string };
      if (
        illegal.status !== 422
        || illegalBody.errorCode !== "CANVAS_CONFIRM_REQUEST_INVALID"
        || stale.status !== 409
        || staleBody.errorCode !== "CANVAS_CONFIRMATION_STALE"
        || accepted.status !== 202
        || receipt.data?.runs?.[0]?.state !== "waiting_for_origin_device"
        || !String(receipt.message ?? "").includes("提交已受理，等待原设备进入任务队列")
        || replay.status !== 202
        || conflictBody.errorCode !== "CANVAS_CONFIRM_IDEMPOTENCY_CONFLICT"
      ) {
        console.error(SENTINEL);
        assert.equal(illegal.status, 422, SENTINEL);
        assert.equal(stale.status, 409, SENTINEL);
        assert.equal(staleBody.errorCode, "CANVAS_CONFIRMATION_STALE", SENTINEL);
        assert.equal(accepted.status, 202, SENTINEL);
        assert.equal(receipt.data?.runs?.[0]?.state, "waiting_for_origin_device", SENTINEL);
        assert.equal(conflictBody.errorCode, "CANVAS_CONFIRM_IDEMPOTENCY_CONFLICT", SENTINEL);
      }
    } finally {
      await close();
    }
  });
});

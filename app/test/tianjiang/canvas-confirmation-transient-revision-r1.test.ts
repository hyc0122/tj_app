import assert from "node:assert/strict";
import test from "node:test";

import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import { mountCanvasRuntimeApp, stubOpenedCanvas } from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:APP_CANVAS_CONFIRMATION_TRANSIENT_REVISION";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000e31";
const NODE_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000e32";

test("确认期间仅进度状态自动保存时不得使视频确认单失效", async () => {
  await runWithTemporaryAccount("canvas-confirmation-transient-revision", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const document = emptyCanvasDocument();
      document.graph.nodes = [{
        nodeUuid: NODE_UUID,
        kind: "video_generation",
        position: { x: 16, y: 16 },
        zIndex: 1,
        collapsed: false,
        data: {
          title: "视频-1",
          prompt: "城市夜景推进镜头",
          modelId: "fixture:video-model",
          status: "running",
          progress: 5,
        },
      }];

      await fetch(`http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/document`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRevision: 0,
          clientMutationId: "018f3d6e-2d9e-7b6c-8a9b-000000000e33",
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
        data?: { confirmationUuid?: string; requestDigest?: string };
      };

      // 中文注释：付费确认框停留期间，前端进度计时器会保存这些运行态字段。
      // 它们不改变用户确认的提示词、模型和输入资产，不应让收费确认单失效。
      (document.graph.nodes[0] as { data?: Record<string, unknown> }).data = {
        title: "视频-1",
        prompt: "城市夜景推进镜头",
        modelId: "fixture:video-model",
        status: "running",
        progress: 6,
      };
      await fetch(`http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/document`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRevision: 1,
          clientMutationId: "018f3d6e-2d9e-7b6c-8a9b-000000000e34",
          document,
        }),
      });

      const confirmed = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirmationUuid: previewBody.data?.confirmationUuid,
            requestDigest: previewBody.data?.requestDigest,
            baseRevision: 1,
            clientRequestId: "018f3d6e-2d9e-7b6c-8a9b-000000000e35",
          }),
        },
      );
      const confirmedBody = await confirmed.json().catch(() => ({})) as {
        data?: { runs?: Array<{ state?: string }> };
        errorCode?: string;
      };

      if (confirmed.status !== 202 || confirmedBody.data?.runs?.[0]?.state !== "waiting_for_origin_device") {
        console.error(SENTINEL, confirmed.status, confirmedBody);
      }
      assert.equal(confirmed.status, 202, SENTINEL);
      assert.equal(confirmedBody.data?.runs?.[0]?.state, "waiting_for_origin_device", SENTINEL);
    } finally {
      await close();
    }
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import { mountCanvasRuntimeApp, stubOpenedCanvas } from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:APP_CANVAS_SSE_AUTH_LOSS";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000d51";

test("聊天 SSE 在撤权后不得继续写入消息或计划", async () => {
  await runWithTemporaryAccount("canvas-sse-auth-loss", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/chat`,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify({
            conversationUuid: "018f3d6e-2d9e-7b6c-8a9b-000000000d52",
            prompt: "流式对话",
            attachmentAssetUuids: [],
            referencedNodeUuids: [],
            baseRevision: 0,
            clientChatRequestId: "018f3d6e-2d9e-7b6c-8a9b-000000000d53",
            requestDigest: "4".repeat(64),
          }),
        },
      );
      const contentType = String(response.headers.get("content-type") ?? "");
      if (response.status === 404 || !contentType.includes("text/event-stream")) {
        console.error(SENTINEL);
        assert.notEqual(response.status, 404, SENTINEL);
        assert.match(contentType, /text\/event-stream/, SENTINEL);
      }
    } finally {
      await close();
    }
  });
});

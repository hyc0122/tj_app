import assert from "node:assert/strict";
import test from "node:test";

import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import { mountCanvasRuntimeApp, stubOpenedCanvas } from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:APP_CANVAS_CHAT_ATTACHMENTS";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000d31";
const ASSET_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000d32";

test("聊天附件只能引用本项目 assetUuid，不得包含路径或 Base64", async () => {
  await runWithTemporaryAccount("canvas-chat-attachments", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const illegal = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/chat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationUuid: "018f3d6e-2d9e-7b6c-8a9b-000000000d33",
            prompt: "描述这张图",
            attachmentAssetUuids: ["C:\\\\temp\\\\a.png", "data:image/png;base64,aaaa"],
            referencedNodeUuids: [],
            baseRevision: 0,
            clientChatRequestId: "018f3d6e-2d9e-7b6c-8a9b-000000000d34",
            requestDigest: "f".repeat(64),
          }),
        },
      );
      const legal = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/chat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationUuid: "018f3d6e-2d9e-7b6c-8a9b-000000000d35",
            prompt: "描述这张图",
            attachmentAssetUuids: [ASSET_UUID],
            referencedNodeUuids: [],
            baseRevision: 0,
            clientChatRequestId: "018f3d6e-2d9e-7b6c-8a9b-000000000d36",
            requestDigest: "1".repeat(64),
          }),
        },
      );
      const illegalBody = await illegal.json().catch(() => ({})) as { errorCode?: string };
      if (
        illegal.status !== 422
        || illegalBody.errorCode !== "CANVAS_CHAT_REQUEST_INVALID"
        || legal.status === 404
      ) {
        console.error(SENTINEL);
        assert.equal(illegal.status, 422, SENTINEL);
        assert.equal(illegalBody.errorCode, "CANVAS_CHAT_REQUEST_INVALID", SENTINEL);
      }
    } finally {
      await close();
    }
  });
});

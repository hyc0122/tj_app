import assert from "node:assert/strict";
import test from "node:test";

import {
  beginCanvasChatReceipt,
} from "../../src/tianjiang/canvas/canvas-chat-receipt";
import { replayOrBegin } from "../../src/tianjiang/canvas/canvas-chat-service";
import { runWithProjectStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { db, initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";

const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-00000000f201";
const REQUEST_ID = "018f3d6e-2d9e-7b6c-8a9b-00000000f202";

test("AI 请求必须先落 submitting，崩溃恢复不得重复调用模型或写 fake 路由", async () => {
  await runWithTemporaryAccount("canvas-chat-receipt-recovery", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await runWithProjectStorage(PROJECT_UUID, async () => {
      await beginCanvasChatReceipt({
        clientChatRequestId: REQUEST_ID,
        requestDigest: "a".repeat(64),
        providerIdempotencyKey: REQUEST_ID,
        modelId: "vendor:text-model",
      });
      const row = await db("canvas_chat_requests").where({ client_chat_request_id: REQUEST_ID }).first();
      assert.equal(String(row.state), "submitting");
      assert.equal(String(row.provider_id), "vendor");
      assert.notEqual(String(row.credential_slot_id), "local-fake");
      await assert.rejects(
        () => replayOrBegin({ clientChatRequestId: REQUEST_ID, requestDigest: "a".repeat(64) }),
        (error: { errorCode?: string }) => error.errorCode === "CANVAS_CHAT_RECOVERY_REQUIRED",
      );
    });
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import {
  ONE_PIXEL_PNG,
  assetDeleteDigest,
  assetUploadDigest,
  mountCanvasRuntimeApp,
  sha256Hex,
  stubOpenedCanvas,
} from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:CANVAS_ASSET_DELETE";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000b21";
const UPLOAD_ID = "018f3d6e-2d9e-7b6c-8a9b-000000000b22";
const DELETE_ID = "018f3d6e-2d9e-7b6c-8a9b-000000000b23";

test("素材删除必须按摘要幂等且重放不得生成第二份 tombstone", async () => {
  await runWithTemporaryAccount("canvas-asset-delete", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const uploadForm = new FormData();
      uploadForm.set("clientAssetMutationId", UPLOAD_ID);
      uploadForm.set("requestDigest", assetUploadDigest(PROJECT_UUID, ONE_PIXEL_PNG, "image/png"));
      uploadForm.set("file", new Blob([ONE_PIXEL_PNG], { type: "image/png" }), "pixel.png");
      const uploaded = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/assets`,
        { method: "POST", body: uploadForm },
      );
      const uploadedBody = await uploaded.json().catch(() => ({})) as {
        data?: { assetUuid?: string };
      };
      const assetUuid = String(uploadedBody.data?.assetUuid ?? "");
      const digest = assetDeleteDigest(PROJECT_UUID, assetUuid, sha256Hex(ONE_PIXEL_PNG));
      const first = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/assets/${assetUuid}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientAssetMutationId: DELETE_ID,
            requestDigest: digest,
            expectedSha256: sha256Hex(ONE_PIXEL_PNG),
          }),
        },
      );
      const replay = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/assets/${assetUuid}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientAssetMutationId: DELETE_ID,
            requestDigest: digest,
            expectedSha256: sha256Hex(ONE_PIXEL_PNG),
          }),
        },
      );
      const firstBody = await first.json().catch(() => ({}));
      const replayBody = await replay.json().catch(() => ({}));
      if (first.status !== 200 || replay.status !== 200 || JSON.stringify(firstBody) !== JSON.stringify(replayBody)) {
        console.error(SENTINEL);
        assert.equal(first.status, 200, SENTINEL);
        assert.equal(replay.status, 200, SENTINEL);
        assert.equal(JSON.stringify(firstBody), JSON.stringify(replayBody), SENTINEL);
      }
    } finally {
      await close();
    }
  });
});

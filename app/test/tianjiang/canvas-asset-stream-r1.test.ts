import assert from "node:assert/strict";
import test from "node:test";

import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import {
  ONE_PIXEL_PNG,
  assetUploadDigest,
  md5Hex,
  mountCanvasRuntimeApp,
  sha256Hex,
  stubOpenedCanvas,
} from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:CANVAS_ASSET_STREAM";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000b01";
const MUTATION_ID = "018f3d6e-2d9e-7b6c-8a9b-000000000b02";

test("流式素材上传必须写入白名单路径并同时计算 MD5/SHA-256", async () => {
  await runWithTemporaryAccount("canvas-asset-stream", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const form = new FormData();
      form.set("clientAssetMutationId", MUTATION_ID);
      form.set("requestDigest", assetUploadDigest(PROJECT_UUID, ONE_PIXEL_PNG, "image/png"));
      form.set("file", new Blob([ONE_PIXEL_PNG], { type: "image/png" }), "pixel.png");
      const response = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/assets`,
        { method: "POST", body: form },
      );
      const body = await response.json().catch(() => ({})) as {
        data?: { assetUuid?: string; relativePath?: string; sha256?: string; md5?: string };
      };
      const pathOk = String(body.data?.relativePath ?? "").startsWith("files/images/");
      const hashOk = body.data?.sha256 === sha256Hex(ONE_PIXEL_PNG) && body.data?.md5 === md5Hex(ONE_PIXEL_PNG);
      if (response.status !== 200 || !body.data?.assetUuid || !pathOk || !hashOk) {
        console.error(SENTINEL);
        assert.equal(response.status, 200, SENTINEL);
        assert.ok(body.data?.assetUuid, SENTINEL);
        assert.ok(pathOk, SENTINEL);
        assert.ok(hashOk, SENTINEL);
      }
    } finally {
      await close();
    }
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { initializeCanvasWorkspace } from "../../src/utils/db";
import { currentUserStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import getPath from "../../src/utils/getPath";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import {
  ONE_PIXEL_PNG,
  assetUploadDigest,
  mountCanvasRuntimeApp,
  stubOpenedCanvas,
} from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:CANVAS_ASSET_RECONCILE";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000b11";
const MUTATION_ID = "018f3d6e-2d9e-7b6c-8a9b-000000000b12";

test("素材提交后 staging 不得进入项目 files 或同步清单", async () => {
  await runWithTemporaryAccount("canvas-asset-reconcile", async () => {
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
      const listed = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/assets`,
      );
      const body = await listed.json().catch(() => ({})) as {
        data?: { assets?: Array<{ relativePath?: string; lifecycleState?: string }> };
      };
      const segment = currentUserStorage()?.segment ?? "";
      const root = projectDirectory(getPath(), PROJECT_UUID, segment);
      const staging = path.join(root, ".staging", "canvas-assets");
      const stagingExists = fs.existsSync(staging) && fs.readdirSync(staging).length > 0;
      const ready = (body.data?.assets ?? []).some((item) =>
        String(item.relativePath ?? "").startsWith("files/images/") && item.lifecycleState === "ready",
      );
      if (response.status !== 200 || listed.status !== 200 || !ready || stagingExists) {
        console.error(SENTINEL);
        assert.equal(response.status, 200, SENTINEL);
        assert.equal(listed.status, 200, SENTINEL);
        assert.equal(stagingExists, false, SENTINEL);
        assert.ok(ready, SENTINEL);
      }
    } finally {
      await close();
    }
  });
});

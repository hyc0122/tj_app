import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import compressing from "compressing";

import { CANVAS_IMPORTER_SCHEMA_VERSION, CANVAS_PORTABLE_FORMAT_VERSION } from "../../src/tianjiang/contracts";
import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import {
  canonicalizeJcs,
  ONE_PIXEL_PNG,
  assetUploadDigest,
  mountCanvasRuntimeApp,
  sha256Hex,
  stubOpenedCanvas,
} from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:CANVAS_PORTABLE_IMPORT_EXPORT";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000b31";

test("导出归档必须是 v1 document/manifest 且不含 staging 或历史", async () => {
  await runWithTemporaryAccount("canvas-portable-export", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/document`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseRevision: 0,
            clientMutationId: "018f3d6e-2d9e-7b6c-8a9b-000000000b32",
            document: emptyCanvasDocument(),
          }),
        },
      );
      const upload = new FormData();
      upload.set("clientAssetMutationId", "018f3d6e-2d9e-7b6c-8a9b-000000000b33");
      upload.set("requestDigest", assetUploadDigest(PROJECT_UUID, ONE_PIXEL_PNG, "image/png"));
      upload.set("file", new Blob([Uint8Array.from(ONE_PIXEL_PNG)], { type: "image/png" }), "pixel.png");
      const uploaded = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/assets`,
        { method: "POST", body: upload },
      );
      assert.equal(uploaded.status, 200);
      const exported = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/export`,
      );
      if (exported.status !== 200) {
        console.error(SENTINEL);
        assert.equal(exported.status, 200, SENTINEL);
        return;
      }
      const zipBytes = Buffer.from(await exported.arrayBuffer());
      const unpackDir = fs.mkdtempSync(path.join(os.tmpdir(), "tj-canvas-export-"));
      const zipPath = path.join(unpackDir, "canvas.tjcanvas");
      fs.writeFileSync(zipPath, zipBytes);
      await compressing.zip.uncompress(zipPath, unpackDir);
      const documentBytes = fs.readFileSync(path.join(unpackDir, "document.json"));
      const manifestBytes = fs.readFileSync(path.join(unpackDir, "manifest.json"));
      const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
        formatVersion?: number;
        importerSchemaVersion?: number;
        documentEntryName?: string;
        documentSha256?: string;
        assets?: Array<{ entryName?: string; sha256?: string; sizeBytes?: number }>;
      };
      const names = fs.readdirSync(unpackDir);
      const ok = exported.status === 200
        && documentBytes.equals(Buffer.from(canonicalizeJcs(JSON.parse(documentBytes.toString("utf8"))), "utf8"))
        && manifest.formatVersion === CANVAS_PORTABLE_FORMAT_VERSION
        && manifest.importerSchemaVersion === CANVAS_IMPORTER_SCHEMA_VERSION
        && manifest.documentEntryName === "document.json"
        && manifest.documentSha256 === sha256Hex(documentBytes)
        && Array.isArray(manifest.assets)
        && manifest.assets.length === 1
        && manifest.assets[0]?.sizeBytes === ONE_PIXEL_PNG.length
        && fs.readFileSync(path.join(unpackDir, String(manifest.assets[0]?.entryName))).equals(ONE_PIXEL_PNG)
        && !names.includes("canvas_revisions")
        && !names.some((name) => name.includes("staging"));
      if (!ok) {
        console.error(SENTINEL);
        assert.ok(ok, SENTINEL);
      }
    } finally {
      await close();
    }
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import { CANVAS_IMPORTER_SCHEMA_VERSION } from "../../src/tianjiang/contracts";
import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import {
  canonicalizeJcs,
  mountCanvasRuntimeApp,
  sha256Hex,
  tjcanvasImportDigest,
  zipStore,
} from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:CANVAS_PORTABLE_IMPORT_MOUNTED";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000b41";
const OTHER_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000b42";

test("未打开或跨项目 portable import 必须统一 403 且零副作用", async () => {
  await runWithTemporaryAccount("canvas-portable-mounted", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const documentBytes = Buffer.from(canonicalizeJcs(emptyCanvasDocument()), "utf8");
      const archive = zipStore([
        { name: "document.json", data: documentBytes },
        { name: "manifest.json", data: Buffer.from(canonicalizeJcs({
          formatVersion: 1,
          importerSchemaVersion: CANVAS_IMPORTER_SCHEMA_VERSION,
          documentEntryName: "document.json",
          documentSha256: sha256Hex(documentBytes),
          assets: [],
        }), "utf8") },
      ]);
      const form = new FormData();
      form.set("baseRevision", "0");
      form.set("clientMutationId", "018f3d6e-2d9e-7b6c-8a9b-000000000b43");
      form.set("requestDigest", tjcanvasImportDigest({
        projectUuid: PROJECT_UUID,
        archiveSha256: sha256Hex(archive),
        archiveSizeBytes: archive.length,
        baseRevision: 0,
        importerSchemaVersion: CANVAS_IMPORTER_SCHEMA_VERSION,
      }));
      form.set("archiveSha256", sha256Hex(archive));
      form.set("archiveSizeBytes", String(archive.length));
      form.set("file", new Blob([Uint8Array.from(archive)], { type: "application/zip" }), "canvas.tjcanvas");
      const closed = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/imports/tjcanvas`,
        { method: "POST", body: form },
      );
      const closedBody = await closed.json().catch(() => ({})) as { errorCode?: string };
      const cross = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${OTHER_UUID}/canvas/imports/tjcanvas`,
        { method: "POST", body: form },
      );
      const crossBody = await cross.json().catch(() => ({})) as { errorCode?: string };
      if (
        closed.status !== 403
        || closedBody.errorCode !== "PERMISSION_DENIED"
        || cross.status !== 403
        || crossBody.errorCode !== "PERMISSION_DENIED"
      ) {
        console.error(SENTINEL);
        assert.equal(closed.status, 403, SENTINEL);
        assert.equal(closedBody.errorCode, "PERMISSION_DENIED", SENTINEL);
        assert.equal(cross.status, 403, SENTINEL);
        assert.equal(crossBody.errorCode, "PERMISSION_DENIED", SENTINEL);
      }
    } finally {
      await close();
    }
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import { accountDb } from "../../src/utils/db";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { CANVAS_IMPORTER_SCHEMA_VERSION } from "../../src/tianjiang/contracts";
import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import {
  canonicalizeJcs,
  mountCanvasRuntimeApp,
  sha256Hex,
  stubOpenedCanvas,
  tjcanvasImportDigest,
  zipStore,
} from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:CANVAS_IMPORT_STAGING_RESERVATION";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000b71";

test("账号 staging 预留必须在读取 file 前生效，且不得进入项目库", async () => {
  await runWithTemporaryAccount("canvas-staging-reservation", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const hasAccountTable = await accountDb.schema.hasTable("canvas_import_staging_reservations");
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
      form.set("clientMutationId", "018f3d6e-2d9e-7b6c-8a9b-000000000b72");
      form.set("requestDigest", tjcanvasImportDigest({
        projectUuid: PROJECT_UUID,
        archiveSha256: sha256Hex(archive),
        archiveSizeBytes: Number.MAX_SAFE_INTEGER,
        baseRevision: 0,
        importerSchemaVersion: CANVAS_IMPORTER_SCHEMA_VERSION,
      }));
      form.set("archiveSha256", sha256Hex(archive));
      form.set("archiveSizeBytes", String(Number.MAX_SAFE_INTEGER));
      form.set("file", new Blob([Uint8Array.from(archive)], { type: "application/zip" }), "canvas.tjcanvas");
      const oversize = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/imports/tjcanvas`,
        { method: "POST", body: form },
      );
      const body = await oversize.json().catch(() => ({})) as { errorCode?: string };
      if (!hasAccountTable || oversize.status !== 507 || body.errorCode !== "CANVAS_STAGING_STORAGE_LIMIT") {
        console.error(SENTINEL);
        assert.equal(hasAccountTable, true, SENTINEL);
        assert.equal(oversize.status, 507, SENTINEL);
        assert.equal(body.errorCode, "CANVAS_STAGING_STORAGE_LIMIT", SENTINEL);
      }
    } finally {
      await close();
    }
  });
});

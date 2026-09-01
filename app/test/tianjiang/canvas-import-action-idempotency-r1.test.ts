import assert from "node:assert/strict";
import test from "node:test";

import { CANVAS_IMPORTER_SCHEMA_VERSION } from "../../src/tianjiang/contracts";
import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import {
  canonicalizeJcs,
  mountCanvasRuntimeApp,
  sha256Hex,
  stubOpenedCanvas,
  tjcanvasImportDigest,
  zipStore,
} from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:CANVAS_IMPORT_ACTION_IDEMPOTENCY";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000b81";
const MUTATION_ID = "018f3d6e-2d9e-7b6c-8a9b-000000000b82";
const ACTION_ID = "018f3d6e-2d9e-7b6c-8a9b-000000000b83";

function actionDigest(importUuid: string, actionType: string, clientActionId: string): string {
  return sha256Hex(canonicalizeJcs({
    operation: actionType,
    importUuid,
    clientActionId,
  }));
}

test("cancel 必须对非法终态失败关闭，合法动作按摘要幂等", async () => {
  await runWithTemporaryAccount("canvas-import-action", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
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
      form.set("clientMutationId", MUTATION_ID);
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
      const accepted = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/imports/tjcanvas`,
        { method: "POST", body: form },
      );
      const receipt = await accepted.json().catch(() => ({})) as { data?: { importUuid?: string } };
      const importUuid = String(receipt.data?.importUuid ?? "018f3d6e-2d9e-7b6c-8a9b-000000000b84");
      const cancel = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/imports/${importUuid}/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientActionId: ACTION_ID,
            requestDigest: actionDigest(importUuid, "cancel", ACTION_ID),
          }),
        },
      );
      const replay = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/imports/${importUuid}/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientActionId: ACTION_ID,
            requestDigest: actionDigest(importUuid, "cancel", ACTION_ID),
          }),
        },
      );
      const firstBody = await cancel.json().catch(() => ({}));
      const replayBody = await replay.json().catch(() => ({}));
      const ok = accepted.status === 202
        && cancel.status === 200
        && replay.status === 200
        && JSON.stringify(firstBody) === JSON.stringify(replayBody);
      if (!ok) {
        console.error(SENTINEL);
        assert.equal(accepted.status, 202, SENTINEL);
        assert.equal(cancel.status, 200, SENTINEL);
        assert.equal(replay.status, 200, SENTINEL);
        assert.equal(JSON.stringify(firstBody), JSON.stringify(replayBody), SENTINEL);
      }
    } finally {
      await close();
    }
  });
});

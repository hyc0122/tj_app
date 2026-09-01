import assert from "node:assert/strict";
import test from "node:test";

import { CANVAS_IMPORTER_SCHEMA_VERSION } from "../../src/tianjiang/contracts";
import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { processCanvasImportJob } from "../../src/tianjiang/canvas/canvas-import-export-service";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import {
  canonicalizeJcs,
  ONE_PIXEL_PNG,
  mountCanvasRuntimeApp,
  sha256Hex,
  stubOpenedCanvas,
  tjcanvasImportDigest,
  zipStore,
} from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:CANVAS_PORTABLE_IMPORT_JOB";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000b51";
const MUTATION_ID = "018f3d6e-2d9e-7b6c-8a9b-000000000b52";

test("tjcanvas 导入必须先返回不可变 202 receipt，再按 clientMutationId 回放", async () => {
  await runWithTemporaryAccount("canvas-portable-job", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const sourceAssetUuid = "018f3d6e-2d9e-7b6c-8a9b-000000000b53";
      const document = emptyCanvasDocument();
      document.graph.nodes = [{
        nodeUuid: "018f3d6e-2d9e-7b6c-8a9b-000000000b54",
        kind: "image",
        position: { x: 0, y: 0 },
        zIndex: 1,
        collapsed: false,
        data: { assetUuid: sourceAssetUuid },
      }];
      const documentBytes = Buffer.from(canonicalizeJcs(document), "utf8");
      const assetSha = sha256Hex(ONE_PIXEL_PNG);
      const archive = zipStore([
        { name: "document.json", data: documentBytes },
        { name: "manifest.json", data: Buffer.from(canonicalizeJcs({
          formatVersion: 1,
          importerSchemaVersion: CANVAS_IMPORTER_SCHEMA_VERSION,
          documentEntryName: "document.json",
          documentSha256: sha256Hex(documentBytes),
          assets: [{
            sourceAssetUuid,
            sourceAssetKey: `asset/${sourceAssetUuid}`,
            entryName: `assets/sha256/${assetSha}`,
            mimeType: "image/png",
            sizeBytes: ONE_PIXEL_PNG.length,
            sha256: assetSha,
          }],
        }), "utf8") },
        { name: `assets/sha256/${assetSha}`, data: ONE_PIXEL_PNG },
      ]);
      const digest = tjcanvasImportDigest({
        projectUuid: PROJECT_UUID,
        archiveSha256: sha256Hex(archive),
        archiveSizeBytes: archive.length,
        baseRevision: 0,
        importerSchemaVersion: CANVAS_IMPORTER_SCHEMA_VERSION,
      });
      const form = new FormData();
      form.set("baseRevision", "0");
      form.set("clientMutationId", MUTATION_ID);
      form.set("requestDigest", digest);
      form.set("archiveSha256", sha256Hex(archive));
      form.set("archiveSizeBytes", String(archive.length));
      form.set("file", new Blob([Uint8Array.from(archive)], { type: "application/zip" }), "canvas.tjcanvas");
      const accepted = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/imports/tjcanvas`,
        { method: "POST", body: form },
      );
      const receipt = await accepted.json().catch(() => ({})) as {
        data?: { importUuid?: string; state?: string; clientMutationId?: string };
      };
      const replay = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/imports/by-client-mutation/${MUTATION_ID}`,
      );
      const replayBody = await replay.json().catch(() => ({})) as {
        data?: { importUuid?: string; clientMutationId?: string };
      };
      try {
        await processCanvasImportJob(PROJECT_UUID, String(receipt.data?.importUuid));
      } catch (error) {
        throw new Error("便携导入 worker 消费失败", { cause: error });
      }
      const completed = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/imports/${receipt.data?.importUuid}`,
      );
      const completedBody = await completed.json().catch(() => ({})) as {
        data?: { state?: string; appliedRevision?: number; totalItems?: number; validatedItems?: number };
      };
      const assetsResponse = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/assets`,
      );
      const assetsBody = await assetsResponse.json().catch(() => ({})) as {
        data?: { assets?: Array<{ assetUuid?: string; sha256?: string }> };
      };
      const documentResponse = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/document`,
      );
      const importedDocument = await documentResponse.json().catch(() => ({})) as {
        data?: { document?: { graph?: { nodes?: Array<{ data?: { assetUuid?: string } }> } } };
      };
      if (
        accepted.status !== 202
        || receipt.data?.state !== "queued"
        || receipt.data?.clientMutationId !== MUTATION_ID
        || replay.status !== 200
        || replayBody.data?.importUuid !== receipt.data?.importUuid
        || completed.status !== 200
        || completedBody.data?.state !== "committed"
        || completedBody.data?.appliedRevision !== 1
        || completedBody.data?.totalItems !== completedBody.data?.validatedItems
        || assetsBody.data?.assets?.length !== 1
        || assetsBody.data?.assets?.[0]?.sha256 !== assetSha
        || importedDocument.data?.document?.graph?.nodes?.[0]?.data?.assetUuid === sourceAssetUuid
        || importedDocument.data?.document?.graph?.nodes?.[0]?.data?.assetUuid !== assetsBody.data?.assets?.[0]?.assetUuid
      ) {
        console.error(SENTINEL);
        assert.equal(accepted.status, 202, SENTINEL);
        assert.equal(receipt.data?.state, "queued", SENTINEL);
        assert.equal(replay.status, 200, SENTINEL);
        assert.equal(replayBody.data?.importUuid, receipt.data?.importUuid, SENTINEL);
        assert.equal(completedBody.data?.state, "committed", SENTINEL);
        assert.equal(assetsBody.data?.assets?.length, 1, SENTINEL);
        assert.equal(assetsBody.data?.assets?.[0]?.sha256, assetSha, SENTINEL);
        assert.equal(
          importedDocument.data?.document?.graph?.nodes?.[0]?.data?.assetUuid,
          assetsBody.data?.assets?.[0]?.assetUuid,
          SENTINEL,
        );
      }
    } finally {
      await close();
    }
  });
});

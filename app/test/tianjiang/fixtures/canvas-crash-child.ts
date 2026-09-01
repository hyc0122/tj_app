/**
 * 真实子进程：走已提交的 Runtime 入口执行 portable import，供父进程在 failpoint 硬杀。
 */
import fs from "node:fs";

import { initializeCanvasWorkspace } from "../../../src/utils/db";
import { CANVAS_IMPORTER_SCHEMA_VERSION } from "../../../src/tianjiang/contracts";
import { emptyCanvasDocument } from "../../../src/tianjiang/canvas/canvas-contracts";
import { runWithTemporaryAccount } from "../helpers/worktree-runtime";
import {
  canonicalizeJcs,
  mountCanvasRuntimeApp,
  sha256Hex,
  stubOpenedCanvas,
  tjcanvasImportDigest,
  zipStore,
} from "../helpers/canvas-crash-harness";

const projectUuid = String(process.env.CANVAS_CRASH_PROJECT_UUID ?? "");
const markerPath = String(process.env.CANVAS_CRASH_MARKER ?? "");
const failpoint = String(process.env.CANVAS_FAILPOINT ?? "");

function mark(state: string): void {
  if (!markerPath) return;
  fs.writeFileSync(markerPath, state, "utf8");
}

async function main(): Promise<void> {
  mark("started");
  await runWithTemporaryAccount("canvas-crash-child", async () => {
    await initializeCanvasWorkspace(projectUuid);
    await stubOpenedCanvas(projectUuid);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const document = emptyCanvasDocument();
      const documentBytes = Buffer.from(canonicalizeJcs(document), "utf8");
      const manifest = {
        formatVersion: 1,
        importerSchemaVersion: CANVAS_IMPORTER_SCHEMA_VERSION,
        documentEntryName: "document.json",
        documentSha256: sha256Hex(documentBytes),
        assets: [],
      };
      const archive = zipStore([
        { name: "document.json", data: documentBytes },
        { name: "manifest.json", data: Buffer.from(canonicalizeJcs(manifest), "utf8") },
      ]);
      const form = new FormData();
      form.set("baseRevision", "0");
      form.set("clientMutationId", "018f3d6e-2d9e-7b6c-8a9b-00000000c001");
      form.set("requestDigest", tjcanvasImportDigest({
        projectUuid,
        archiveSha256: sha256Hex(archive),
        archiveSizeBytes: archive.length,
        baseRevision: 0,
        importerSchemaVersion: CANVAS_IMPORTER_SCHEMA_VERSION,
      }));
      form.set("archiveSha256", sha256Hex(archive));
      form.set("archiveSizeBytes", String(archive.length));
      form.set("file", new Blob([Uint8Array.from(archive)], { type: "application/zip" }), "canvas.tjcanvas");
      mark("uploading");
      const response = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${projectUuid}/canvas/imports/tjcanvas`,
        { method: "POST", body: form },
      );
      const body = await response.json().catch(() => ({}));
      fs.writeFileSync(`${markerPath}.json`, JSON.stringify({ status: response.status, body }), "utf8");
      mark(`http:${response.status}`);
      // 中文注释：先落盘不可变 receipt，再进入 failpoint，父进程硬杀后仍能核对 202。
      if (failpoint === "after-accept") {
        await new Promise(() => undefined);
      }
    } finally {
      await close();
    }
  });
  mark("exited");
}

main().catch((error) => {
  mark(`error:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

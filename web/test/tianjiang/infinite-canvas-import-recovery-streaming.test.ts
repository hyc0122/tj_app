// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_IMPORT_RECOVERY_STREAMING";

function webSrc(relative: string): string {
  try {
    return readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src", relative),
      "utf8",
    );
  } catch {
    console.error(SENTINEL);
    expect.fail(SENTINEL);
    return "";
  }
}

describe("便携导入恢复与流式 SHA-256", () => {
  it("hash 必须在 Worker 中用 File.stream 增量计算，禁止整文件 arrayBuffer", () => {
    const worker = webSrc("features/tianjiang/canvas/streaming-sha256-worker.ts");
    if (
      !worker.includes("File.stream") && !worker.includes("file.stream")
      || !worker.includes("hash-wasm")
      || worker.includes("arrayBuffer(")
      || worker.includes("atob(")
      || worker.includes("readAsDataURL")
    ) {
      console.error(SENTINEL);
      expect(worker.includes("hash-wasm"), SENTINEL).toBe(true);
      expect(worker.includes("arrayBuffer("), SENTINEL).toBe(false);
    }
  });

  it("导入 intent 必须先耐久再 POST，重启按 by-client-mutation 恢复终态", () => {
    const haystack = [
      webSrc("features/tianjiang/canvas/import-receipt-store.ts"),
      webSrc("views/infiniteCanvas/components/CanvasImportExportDialog.vue"),
      webSrc("features/tianjiang/canvas/api.ts"),
    ].join("\n");
    const required = [
      "pending",
      "accepted",
      "clientMutationId",
      "requestDigest",
      "archiveSha256",
      "importerSchemaVersion",
      "by-client-mutation",
      "clientActionId",
      "actionType",
      "AbortController",
      "terminate",
      "indexedDB",
    ];
    const missing = required.filter((token) => !haystack.includes(token));
    if (missing.length !== 0) {
      console.error(SENTINEL);
      expect(missing, SENTINEL).toEqual([]);
    }
  });
});

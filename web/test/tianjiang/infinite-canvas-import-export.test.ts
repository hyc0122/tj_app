// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_IMPORT_EXPORT";

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

describe("画布导入导出合同", () => {
  it("必须从生成合同读取 importer/portable 版本并走真实 Runtime API", () => {
    const haystack = [
      webSrc("features/tianjiang/canvas/api.ts"),
      webSrc("views/infiniteCanvas/components/CanvasImportExportDialog.vue"),
    ].join("\n");
    const required = [
      "CANVAS_IMPORTER_SCHEMA_VERSION",
      "CANVAS_PORTABLE_FORMAT_VERSION",
      "/canvas/imports/tjcanvas",
      "/canvas/imports/json",
      "/canvas/imports/novel",
      "/canvas/export",
      "archiveSha256",
      "archiveSizeBytes",
      "requestDigest",
      "baseRevision",
      "clientMutationId",
      "已受理",
    ];
    const missing = required.filter((token) => !haystack.includes(token));
    if (missing.length !== 0) {
      console.error(SENTINEL);
      expect(missing, SENTINEL).toEqual([]);
    }
    if (haystack.includes("/api/api/") || haystack.includes("teamUuid")) {
      console.error(SENTINEL);
      expect(haystack.includes("/api/api/"), SENTINEL).toBe(false);
    }
  });

  it("FormData 字段必须按固定顺序发送且 202 不得伪称 queued", () => {
    const haystack = [
      webSrc("features/tianjiang/canvas/api.ts"),
      webSrc("views/infiniteCanvas/components/CanvasImportExportDialog.vue"),
    ].join("\n");
    const order = [
      'form.append("baseRevision"',
      'form.append("clientMutationId"',
      'form.append("requestDigest"',
      'form.append("archiveSha256"',
      'form.append("archiveSizeBytes"',
      'form.append("file"',
    ];
    const indexes = order.map((token) => haystack.indexOf(token));
    const unordered = indexes.some((index, offset) => index < 0 || (offset > 0 && index <= indexes[offset - 1]));
    if (unordered || haystack.includes("queued") && haystack.includes("已受理") === false) {
      console.error(SENTINEL);
      expect(indexes.every((index) => index >= 0), SENTINEL).toBe(true);
      expect(haystack.includes("已受理"), SENTINEL).toBe(true);
    }
  });
});

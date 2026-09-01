// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_SYNC_STATUS";

describe("本地保存与云端同步必须分列", () => {
  it("store 不得用已同步表示 SQLite 保存成功", () => {
    const target = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src/stores/canvas.ts",
    );
    let src = "";
    try {
      src = readFileSync(target, "utf8");
    } catch {
      console.error(SENTINEL);
      expect.fail(SENTINEL);
    }
    if (!src.includes("persist: false") || !src.includes("saveState") || !src.includes("cloudSyncState")) {
      console.error(SENTINEL);
      expect(src.includes("persist: false"), SENTINEL).toBe(true);
      expect(src.includes("saveState"), SENTINEL).toBe(true);
      expect(src.includes("cloudSyncState"), SENTINEL).toBe(true);
    }
  });
});

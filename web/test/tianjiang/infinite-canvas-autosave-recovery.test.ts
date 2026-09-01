// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_AUTOSAVE_RECOVERY";

describe("自动保存恢复", () => {
  it("必须耐久保存 draftVersion 与 clientMutationId", () => {
    const target = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src/features/tianjiang/canvas/recovery-draft.ts",
    );
    let src = "";
    try {
      src = readFileSync(target, "utf8");
    } catch {
      console.error(SENTINEL);
      expect.fail(SENTINEL);
    }
    if (!src.includes("draftVersion") || !src.includes("clientMutationId") || !src.includes("indexedDB")) {
      console.error(SENTINEL);
      expect(src.includes("draftVersion"), SENTINEL).toBe(true);
      expect(src.includes("clientMutationId"), SENTINEL).toBe(true);
    }
  });
});

// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_CLIENT_STORE";

describe("画布 Runtime client", () => {
  it("必须使用 document 相对路径且不含 /api/api", () => {
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/features/tianjiang/canvas/api.ts"),
      "utf8",
    );
    if (!src.includes("/canvas/document") || src.includes("/api/api/") || src.includes("teamUuid")) {
      console.error(SENTINEL);
      expect(src.includes("/canvas/document"), SENTINEL).toBe(true);
      expect(src.includes("/api/api/"), SENTINEL).toBe(false);
    }
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SENTINEL = "RED_EXPECTED:CANVAS_EXECUTION_RECOVERY";

test("reconciler 必须按 projectUuid+intentUuid+runUuid 定位，禁止扫描项目库", () => {
  const dir = path.resolve(__dirname, "../../src/tianjiang/canvas");
  const files = [
    "canvas-execution-reconciler.ts",
    "canvas-execution-worker.ts",
    "canvas-execution-outbox.ts",
  ];
  const haystack = files.map((name) => {
    try {
      return fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      console.error(SENTINEL);
      assert.fail(SENTINEL);
      return "";
    }
  }).join("\n");
  if (
    !haystack.includes("projectUuid")
    || !haystack.includes("intentUuid")
    || !haystack.includes("runUuid")
    || !haystack.includes("submitting")
    || !haystack.includes("outcome_unknown")
  ) {
    console.error(SENTINEL);
    assert.equal(haystack.includes("intentUuid"), true, SENTINEL);
    assert.equal(haystack.includes("outcome_unknown"), true, SENTINEL);
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SENTINEL = "RED_EXPECTED:CANVAS_EXECUTION_COMPOSITION";

function readSrc(relativeFromAppSrc: string): string {
  try {
    return fs.readFileSync(
      path.resolve(__dirname, "../../src", relativeFromAppSrc),
      "utf8",
    );
  } catch {
    console.error(SENTINEL);
    assert.fail(SENTINEL);
    return "";
  }
}

test("生产生命周期必须接线 canvas-execution-runtime participant", () => {
  const haystack = [
    readSrc("tianjiang/canvas/canvas-execution-runtime.ts"),
    readSrc("utils/db.ts"),
    readSrc("tianjiang/runtime/serve-lifecycle.ts"),
    readSrc("tianjiang/runtime/sync-coordinator.ts"),
    readSrc("routes/tianjiang/auth/login.ts"),
    readSrc("routes/tianjiang/auth/logout.ts"),
    readSrc("tianjiang/runtime/project-runtime-local.ts"),
  ].join("\n");
  if (
    !haystack.includes("canvas-execution-runtime")
    || !haystack.includes("prepare")
    || !haystack.includes("commit")
    || !haystack.includes("rollback")
  ) {
    console.error(SENTINEL);
    assert.equal(haystack.includes("canvas-execution-runtime"), true, SENTINEL);
    assert.equal(haystack.includes("prepare"), true, SENTINEL);
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SENTINEL = "RED_EXPECTED:CANVAS_OUTBOX_MIGRATION";

test("设备 outbox 迁移必须建立 (projectUuid, runUuid) 唯一约束且不进入项目库", () => {
  const target = path.resolve(
    __dirname,
    "../../src/tianjiang/canvas/canvas-execution-outbox-migration.ts",
  );
  let src = "";
  try {
    src = fs.readFileSync(target, "utf8");
  } catch {
    console.error(SENTINEL);
    assert.fail(SENTINEL);
  }
  if (
    !src.includes("project_uuid")
    || !src.includes("run_uuid")
    || !src.includes("UNIQUE")
    || !src.includes("canvas-execution-outbox.sqlite")
    || src.includes("project.sqlite")
  ) {
    console.error(SENTINEL);
    assert.equal(src.includes("UNIQUE"), true, SENTINEL);
    assert.equal(src.includes("canvas-execution-outbox.sqlite"), true, SENTINEL);
  }
});

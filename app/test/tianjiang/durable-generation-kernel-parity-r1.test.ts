import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SENTINEL = "RED_EXPECTED:APP_DURABLE_KERNEL";

function readSrc(relativeFromAppSrc: string): string {
  const target = path.resolve(
    __dirname,
    "../../src",
    relativeFromAppSrc,
  );
  try {
    return fs.readFileSync(target, "utf8");
  } catch {
    console.error(SENTINEL);
    assert.fail(SENTINEL);
    return "";
  }
}

test("通用 durable kernel 不得依赖分镜 shotUuid，且现有 vendor 入口必须接入", () => {
  const kernel = readSrc("tianjiang/generation/durable-generation-operation.ts");
  const worker = readSrc("tianjiang/generation/durable-generation-worker.ts");
  const vendorOp = readSrc("tianjiang/storyboard/vendor-generation-operation.ts");
  const vendorSched = readSrc("tianjiang/storyboard/vendor-generation-scheduler.ts");
  if (
    kernel.includes("shotUuid")
    || kernel.includes("storyboard")
    || worker.includes("shotUuid")
    || !vendorOp.includes("durable-generation-operation")
    || !vendorSched.includes("durable-generation-worker")
  ) {
    console.error(SENTINEL);
    assert.equal(kernel.includes("shotUuid"), false, SENTINEL);
    assert.equal(vendorOp.includes("durable-generation-operation"), true, SENTINEL);
    assert.equal(vendorSched.includes("durable-generation-worker"), true, SENTINEL);
  }
});

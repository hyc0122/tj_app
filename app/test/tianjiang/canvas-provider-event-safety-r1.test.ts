import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SENTINEL = "RED_EXPECTED:CANVAS_PROVIDER_EVENT_SAFETY";

test("规范化事件不得保留 Secret、签名 URL 或原始 Provider 调试对象", () => {
  const target = path.resolve(
    __dirname,
    "../../src/tianjiang/canvas/canvas-provider-event-normalizer.ts",
  );
  let src = "";
  try {
    src = fs.readFileSync(target, "utf8");
  } catch {
    console.error(SENTINEL);
    assert.fail(SENTINEL);
  }
  if (
    !src.includes("[REDACTED_SECRET]")
    || !src.includes("MAX_PROVIDER_FAILURE_BYTES")
    || src.includes("v-html")
  ) {
    console.error(SENTINEL);
    assert.equal(src.includes("[REDACTED_SECRET]"), true, SENTINEL);
    assert.equal(src.includes("MAX_PROVIDER_FAILURE_BYTES"), true, SENTINEL);
  }
});

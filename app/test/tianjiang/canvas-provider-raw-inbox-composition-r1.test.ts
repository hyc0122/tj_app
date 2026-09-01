import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SENTINEL = "RED_EXPECTED:CANVAS_RAW_INBOX_COMPOSITION";

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

test("登录恢复、退出停止、项目切换与 activateUserDatabase 必须接线 raw inbox", () => {
  const haystack = [
    readSrc("tianjiang/canvas/canvas-provider-raw-inbox.ts"),
    readSrc("tianjiang/runtime/serve-lifecycle.ts"),
    readSrc("routes/tianjiang/auth/login.ts"),
    readSrc("routes/tianjiang/auth/logout.ts"),
    readSrc("tianjiang/runtime/project-runtime-local.ts"),
  ].join("\n");
  const dbSrc = readSrc("utils/db.ts");
  const activateBlock = dbSrc.slice(dbSrc.indexOf("export async function activateUserDatabase"));
  if (
    !haystack.includes("canvas-provider-raw-inbox")
    || !haystack.includes("stopRawInboxConsumer")
    || !haystack.includes("resumeRawInboxConsumer")
    || !activateBlock.includes("resumeRawInboxConsumer")
  ) {
    console.error(SENTINEL);
    assert.equal(haystack.includes("resumeRawInboxConsumer"), true, SENTINEL);
    assert.equal(haystack.includes("stopRawInboxConsumer"), true, SENTINEL);
    assert.equal(activateBlock.includes("resumeRawInboxConsumer"), true, SENTINEL);
  }
});

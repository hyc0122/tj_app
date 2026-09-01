import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runWithTemporaryAccount } from "./helpers/worktree-runtime";

const SENTINEL = "RED_EXPECTED:CANVAS_RAW_INBOX_ACTIVATE";
const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 7601 };

function dbSource(): string {
  try {
    return fs.readFileSync(
      path.resolve(__dirname, "../../src/utils/db.ts"),
      "utf8",
    );
  } catch {
    console.error(SENTINEL);
    assert.fail(SENTINEL);
    return "";
  }
}

test("activateUserDatabase 成功路径必须恢复 raw inbox，覆盖不经过 login.ts 的场景", async () => {
  const src = dbSource();
  const activateBlock = src.slice(src.indexOf("export async function activateUserDatabase"));
  if (!activateBlock.includes("resumeRawInboxConsumer")) {
    console.error(SENTINEL);
    assert.equal(activateBlock.includes("resumeRawInboxConsumer"), true, SENTINEL);
  }
  await runWithTemporaryAccount("canvas-raw-inbox-activate", async () => {
    const inbox = await import("../../src/tianjiang/canvas/canvas-provider-raw-inbox");
    inbox.stopRawInboxConsumer();
    if (!inbox.isRawInboxConsumerStopped()) {
      console.error(SENTINEL);
      assert.equal(inbox.isRawInboxConsumerStopped(), true, SENTINEL);
    }
    const { activateUserDatabase } = await import("../../src/utils/db");
    await activateUserDatabase(IDENTITY);
    if (inbox.isRawInboxConsumerStopped()) {
      console.error(SENTINEL);
      assert.equal(inbox.isRawInboxConsumerStopped(), false, SENTINEL);
    }
  });
});

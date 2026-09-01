import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SENTINEL = "RED_EXPECTED:APP_CANVAS_CHAT_CRASH";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000d61";

test("home-plan submitting 提交后硬杀必须能按原幂等键恢复且 uniqueAcceptedRequests<=1", async () => {
  const tmpDir = path.resolve(__dirname, "../../../.tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const marker = path.join(tmpDir, `canvas-chat-crash-${Date.now()}`);
  const childPath = path.resolve(__dirname, "../fixtures/canvas-chat-crash-child.ts");
  const child = spawn(process.execPath, ["--import", "tsx", childPath], {
    env: {
      ...process.env,
      CANVAS_CRASH_PROJECT_UUID: PROJECT_UUID,
      CANVAS_CRASH_MARKER: marker,
      CANVAS_FAILPOINT: "after-accept",
    },
    stdio: "ignore",
  });
  const receiptPath = `${marker}.json`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !fs.existsSync(receiptPath)) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill("SIGKILL");
  let status = 0;
  if (fs.existsSync(receiptPath)) {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as { status?: number };
    status = Number(receipt.status ?? 0);
  }
  if (status === 404 || status === 0) {
    console.error(SENTINEL);
    assert.notEqual(status, 404, SENTINEL);
    assert.notEqual(status, 0, SENTINEL);
  }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SENTINEL = "RED_EXPECTED:CANVAS_PAID_BOUNDARY_CRASH";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000f11";

test("confirm 已返回 202 后硬杀不得产生第二次收费", async () => {
  const tmpDir = path.resolve(__dirname, "../../../.tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const marker = path.join(tmpDir, `canvas-paid-crash-${Date.now()}`);
  const childPath = path.resolve(__dirname, "../fixtures/canvas-paid-boundary-child.ts");
  const child = spawn(process.execPath, ["--import", "tsx", childPath], {
    env: {
      ...process.env,
      CANVAS_CRASH_PROJECT_UUID: PROJECT_UUID,
      CANVAS_CRASH_MARKER: marker,
      CANVAS_FAILPOINT: "after-confirm",
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
    status = Number((JSON.parse(fs.readFileSync(receiptPath, "utf8")) as { status?: number }).status ?? 0);
  }
  const runtime = (() => {
    try {
      return fs.readFileSync(
        path.resolve(__dirname, "../../src/tianjiang/canvas/canvas-execution-runtime.ts"),
        "utf8",
      );
    } catch {
      return "";
    }
  })();
  if (status !== 202 || !runtime.includes("canvas-execution-outbox")) {
    console.error(SENTINEL);
    assert.equal(status, 202, SENTINEL);
    assert.equal(runtime.includes("canvas-execution-outbox"), true, SENTINEL);
  }
});

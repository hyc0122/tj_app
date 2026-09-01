import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { spawnCanvasCrashChild } from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:CANVAS_PORTABLE_IMPORT_CRASH";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000b61";

test("hard-kill 后全新进程只能 committed 一次、等待重传或 recovery_required", async () => {
  const marker = path.join(os.tmpdir(), `canvas-crash-${process.pid}.marker`);
  fs.writeFileSync(marker, "init", "utf8");
  const child = spawnCanvasCrashChild({
    CANVAS_CRASH_PROJECT_UUID: PROJECT_UUID,
    CANVAS_CRASH_MARKER: marker,
    CANVAS_FAILPOINT: "after-accept",
  });
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const text = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
    if (text.startsWith("http:") || text.startsWith("error:") || fs.existsSync(`${marker}.json`)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  const markerText = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
  const receiptPath = `${marker}.json`;
  const receipt = fs.existsSync(receiptPath)
    ? JSON.parse(fs.readFileSync(receiptPath, "utf8")) as { status?: number; body?: { data?: { state?: string } } }
    : {};
  const recovered = receipt.status === 202
    && (receipt.body?.data?.state === "queued"
      || receipt.body?.data?.state === "committed"
      || receipt.body?.data?.state === "recovery_required"
      || receipt.body?.data?.state === "awaiting_reupload");
  if (!recovered) {
    console.error(SENTINEL);
    assert.ok(recovered, `${SENTINEL} marker=${markerText}`);
  }
});

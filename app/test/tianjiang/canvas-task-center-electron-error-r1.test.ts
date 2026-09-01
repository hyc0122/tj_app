import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const SENTINEL = "RED_EXPECTED:CANVAS_TASK_CENTER_ELECTRON_ERROR";

test("任务中心长错误必须在真实 Electron 窗口中可展开为完整已安全处理文本", async () => {
  const helper = path.resolve(
    __dirname,
    "./helpers/canvas-task-center-electron-window.mjs",
  );
  if (!fs.existsSync(helper)) {
    console.error(SENTINEL);
    assert.fail(SENTINEL);
  }
  const helperHref: string = pathToFileURL(helper).href;
  const { launchTaskCenterLongErrorWindow } = await import(helperHref) as {
    launchTaskCenterLongErrorWindow: () => Promise<{
      windowType?: string;
      expanded?: boolean;
      expandedText?: string;
    }>;
  };
  if (typeof launchTaskCenterLongErrorWindow !== "function") {
    console.error(SENTINEL);
    assert.equal(typeof launchTaskCenterLongErrorWindow, "function", SENTINEL);
    return;
  }
  const observed = await launchTaskCenterLongErrorWindow();
  const longError = String(observed?.expandedText ?? "");
  if (
    observed?.windowType !== "BrowserWindow"
    || !longError.includes("VENDOR_BALANCE_EMPTY_42")
    || longError.includes("<script>")
    || longError.includes("Bearer ")
    || !longError.includes("[REDACTED_SECRET]")
    || observed?.expanded !== true
  ) {
    console.error(SENTINEL);
    assert.equal(observed?.windowType, "BrowserWindow", SENTINEL);
    assert.equal(observed?.expanded, true, SENTINEL);
    assert.match(longError, /VENDOR_BALANCE_EMPTY_42/, SENTINEL);
  }
});

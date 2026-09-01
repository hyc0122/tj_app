// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_EXECUTION_CONFIRMATION";

function webSrc(relative: string): string {
  try {
    return readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src", relative),
      "utf8",
    );
  } catch {
    console.error(SENTINEL);
    expect.fail(SENTINEL);
    return "";
  }
}

describe("执行确认与执行台合同", () => {
  it("必须展示权威预览、防双击 confirm、202 waiting_for_origin_device 且不得提前 queued", () => {
    const haystack = [
      webSrc("features/tianjiang/canvas/useCanvasExecution.ts"),
      webSrc("features/tianjiang/canvas/api.ts"),
      webSrc("views/infiniteCanvas/components/execution/CanvasExecutionDesk.vue"),
      webSrc("views/infiniteCanvas/components/execution/CanvasExecutionPreviewDialog.vue"),
      webSrc("views/infiniteCanvas/editor.vue"),
    ].join("\n");
    const required = [
      "waiting_for_origin_device",
      "clientRequestId",
      "requestDigest",
      "confirmationUuid",
      "previewCanvasExecution",
      "confirmCanvasExecution",
      "confirming",
      "originDevice",
      "CanvasExecutionDesk",
      "CanvasExecutionPreviewDialog",
      "fee",
      "queued",
      "runGeneration",
    ];
    const missing = required.filter((token) => !haystack.includes(token));
    if (missing.length !== 0) {
      console.error(SENTINEL);
      expect(missing, SENTINEL).toEqual([]);
    }
  });

  it("失败重试必须重新 preview 并提升 runGeneration，执行台计数包含待确认与运行中", () => {
    const execution = webSrc("features/tianjiang/canvas/useCanvasExecution.ts");
    const desk = webSrc("views/infiniteCanvas/components/execution/CanvasExecutionDesk.vue");
    const editor = webSrc("views/infiniteCanvas/editor.vue");
    const retryBody = execution.match(/async function retryExecution[\s\S]*?\n  }/)?.[0] ?? "";
    if (
      !execution.includes("retryExecution")
      || !execution.includes("runGeneration")
      || !desk.includes("pendingCount")
      || !desk.includes("confirmation_required")
      || !desk.includes("aria-live")
      || retryBody.includes("confirmPreview()")
      || !editor.includes("openExecutionPreview")
      || !editor.includes("showPreview.value = true")
    ) {
      console.error(SENTINEL);
      expect(execution.includes("retryExecution"), SENTINEL).toBe(true);
      expect(desk.includes("pendingCount"), SENTINEL).toBe(true);
      expect(retryBody.includes("confirmPreview()"), SENTINEL).toBe(false);
      expect(editor.includes("openExecutionPreview"), SENTINEL).toBe(true);
    }
  });
});

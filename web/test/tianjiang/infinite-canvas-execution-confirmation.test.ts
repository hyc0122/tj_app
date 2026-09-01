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

function tapSrc(relative: string): string {
  try {
    return readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../tapcanvas/src", relative),
      "utf8",
    );
  } catch {
    console.error(SENTINEL);
    expect.fail(SENTINEL);
    return "";
  }
}

function appSrc(relative: string): string {
  try {
    return readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../app/src", relative),
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
      tapSrc("api/server.ts"),
      tapSrc("tianjiang/confirmGate.ts"),
      appSrc("routes/tianjiang/tapcanvas-compat.ts"),
    ].join("\n");
    const required = [
      "waiting_for_origin_device",
      "clientRequestId",
      "requestDigest",
      "confirmationUuid",
      "previewCanvasExecution",
      "confirmCanvasExecution",
      "requestTianjiangPaidConfirm",
      "runPublicTaskWithAuth",
      "fee",
      "queued",
    ];
    const missing = required.filter((token) => !haystack.includes(token));
    if (missing.length !== 0) {
      console.error(SENTINEL);
      expect(missing, SENTINEL).toEqual([]);
    }
  });

  it("确认后必须复用服务端返回的原确认单，禁止重新预览或自行伪造凭证", () => {
    const client = tapSrc("api/server.ts");
    const route = appSrc("routes/tianjiang/tapcanvas-compat.ts");
    const confirmationSubmit = client.match(/async function continuePublicTaskAfterConfirmation[\s\S]*?export async function runPublicTaskWithAuth/)?.[0] ?? "";
    expect(confirmationSubmit, SENTINEL).toContain("confirmationUuid: preview.confirmationUuid");
    expect(confirmationSubmit, SENTINEL).toContain("requestDigest: preview.requestDigest");
    expect(confirmationSubmit, SENTINEL).toContain("baseRevision: preview.baseRevision");
    expect(route, SENTINEL).toContain("confirmCanvasExecution(parsed.projectUuid, parsed.confirmation!)");
    expect(route, SENTINEL).not.toContain("FAKE_PROVIDER");
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SENTINEL = "RED_EXPECTED:TAPCANVAS_COMPAT";

function readSrc(relative: string): string {
  try {
    return fs.readFileSync(path.resolve(__dirname, "../../src", relative), "utf8");
  } catch {
    console.error(SENTINEL);
    assert.fail(SENTINEL);
    return "";
  }
}

test("TapCanvas 兼容层必须复用天将账号、真实模型路由和权威确认执行", () => {
  const haystack = [
    readSrc("routes/tianjiang/tapcanvas-compat.ts"),
    readSrc("app.ts"),
    readSrc("tianjiang/canvas/canvas-document-service.ts"),
    readSrc("tianjiang/canvas/canvas-execution-service.ts"),
  ].join("\n");
  const required = [
    "/api/tianjiang/tapcanvas",
    "auth/session",
    "confirmationUuid",
    "previewCanvasExecution",
    "confirmCanvasExecution",
    "waiting_for_origin_device",
    "parseTapCanvasTaskRequest",
    "requestDigest",
    "encodeTapCanvasTaskId",
    "decodeTapCanvasTaskId",
    "TAPCANVAS_HIDE_TEAM",
    "new-api-models",
    "project-directory",
    "public/agents/chat",
  ];
  const missing = required.filter((token) => !haystack.includes(token));
  if (missing.length !== 0) {
    console.error(SENTINEL);
    assert.deepEqual(missing, [], SENTINEL);
  }
  const forbidden = [
    "FAKE_PROVIDER",
    "fake:",
    "执行仍走 fake provider",
    "res.status(200).send({ ok: true",
    "overlayProjects = new Map",
    "directoryByUser = new Map",
  ];
  const leaked = forbidden.filter((token) => haystack.includes(token));
  assert.deepEqual(leaked, [], "TapCanvas 生产兼容层不得伪造模型、任务或未知接口成功回执");
  assert.match(haystack, /TAPCANVAS_DIRECTORY_SETTING_KEY/,
    "项目目录必须持久化到账号设置，禁止仅保存在进程内存");
  assert.match(haystack, /TAPCANVAS_PROJECT_ALIAS_SETTING_KEY/,
    "项目重命名必须持久化到账号设置，禁止重启后丢失");
});

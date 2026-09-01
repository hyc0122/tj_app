import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeTapCanvasTaskId,
  encodeTapCanvasTaskId,
  mapCanvasRunState,
  parseTapCanvasTaskRequest,
} from "../../src/tianjiang/canvas/tapcanvas-task-contract";

const projectUuid = "28a7ee5d-1951-46f9-a463-80876de259e9";
const nodeUuid = "c95cf1a7-39a4-4f1b-ae8e-4c98ef278876";
const runUuid = "9ff9cc4a-0f5a-4b9d-877a-902d1cc2dd02";

test("TapCanvas 生成请求只接受画布上下文与真实模型键", () => {
  const parsed = parseTapCanvasTaskRequest({
    request: {
      kind: "text_to_image",
      prompt: "生成一张电影海报",
      extras: {
        modelKey: "jiasu:flux-pro",
        generationContext: { projectId: projectUuid, nodeId: nodeUuid },
      },
    },
  });

  assert.deepEqual(parsed, {
    taskKind: "text_to_image",
    mediaType: "image",
    projectUuid,
    nodeUuid,
    modelKey: "jiasu:flux-pro",
    confirmation: null,
  });
});

test("TapCanvas 确认请求必须完整携带同一权威确认单", () => {
  const confirmationUuid = "38c69d4a-84fa-42b2-bdb0-b1534185512d";
  const clientRequestId = "07fc40a7-059c-41bf-bc27-03eedf2ec15f";
  const parsed = parseTapCanvasTaskRequest({
    confirmationUuid,
    requestDigest: "a".repeat(64),
    baseRevision: 7,
    clientRequestId,
    request: {
      kind: "text_to_video",
      prompt: "生成五秒镜头",
      extras: {
        modelKey: "jiasu:seedance",
        generationContext: { projectId: projectUuid, nodeId: nodeUuid },
      },
    },
  });

  assert.deepEqual(parsed.confirmation, {
    confirmationUuid,
    requestDigest: "a".repeat(64),
    baseRevision: 7,
    clientRequestId,
  });
  assert.equal(parsed.mediaType, "video");

  assert.throws(() => parseTapCanvasTaskRequest({
    confirmationUuid,
    request: {
      kind: "text_to_video",
      prompt: "生成五秒镜头",
      extras: {
        modelKey: "jiasu:seedance",
        generationContext: { projectId: projectUuid, nodeId: nodeUuid },
      },
    },
  }), /确认合同不完整/);
});

test("TapCanvas 任务 ID 可无状态定位项目与运行，状态映射符合前端合同", () => {
  const taskId = encodeTapCanvasTaskId(projectUuid, runUuid);
  assert.deepEqual(decodeTapCanvasTaskId(taskId), { projectUuid, runUuid });
  assert.equal(mapCanvasRunState("waiting_for_origin_device"), "queued");
  assert.equal(mapCanvasRunState("running"), "running");
  assert.equal(mapCanvasRunState("succeeded"), "succeeded");
  assert.equal(mapCanvasRunState("failed"), "failed");
  assert.throws(() => decodeTapCanvasTaskId("not-a-task"), /任务标识不合法/);
});

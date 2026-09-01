import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { taskCenterList } from "../../src/tianjiang/tasks/task-center-service";
import { canvasOwnerSession, mountCanvasRuntimeApp, stubOpenedCanvas } from "./helpers/canvas-crash-harness";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";

const SENTINEL = "RED_EXPECTED:CANVAS_TASK_CENTER";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000001031";
const NODE_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000001032";

test("任务中心必须按账号项目隔离展示画布终态与完整失败原因", async () => {
  const eventsPath = path.resolve(
    __dirname,
    "../../src/tianjiang/canvas/canvas-execution-events.ts",
  );
  if (!fs.existsSync(eventsPath)) {
    console.error(SENTINEL);
    assert.fail(SENTINEL);
  }
  await runWithTemporaryAccount("canvas-task-center", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID, { name: "画布任务" });
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const document = emptyCanvasDocument();
      document.graph.nodes = [{
        nodeUuid: NODE_UUID,
        kind: "image_generation",
        position: { x: 3, y: 3 },
        zIndex: 1,
        collapsed: false,
        data: { title: "出图", prompt: "失败样本" },
      }];
      await fetch(`http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/document`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRevision: 0,
          clientMutationId: "018f3d6e-2d9e-7b6c-8a9b-000000001033",
          document,
        }),
      });
      const preview = await (await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseRevision: 1, nodeUuids: [NODE_UUID] }),
        },
      )).json() as { data?: { confirmationUuid?: string; requestDigest?: string } };
      const confirmed = await (await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirmationUuid: preview.data?.confirmationUuid,
            requestDigest: preview.data?.requestDigest,
            baseRevision: 1,
            clientRequestId: "018f3d6e-2d9e-7b6c-8a9b-000000001034",
          }),
        },
      )).json() as { data?: { runs?: Array<{ runUuid?: string }> } };
      const runUuid = String(confirmed.data?.runs?.[0]?.runUuid ?? "");
      const { ingestCanvasProviderEvent } = await import("../../src/tianjiang/canvas/canvas-execution-events");
      await ingestCanvasProviderEvent({
        eventId: "fail-1",
        runId: runUuid,
        projectUuid: PROJECT_UUID,
        providerId: "fake-provider",
        accountId: "7601",
        deviceUuid: "origin",
        sequence: 4,
        occurredAt: new Date().toISOString(),
        schemaVersion: 1,
        status: "failed",
        failureText: "供应商拒绝：余额不足，请充值后重试。详细诊断码 VENDOR_BALANCE_EMPTY_42。",
      });
      const listed = taskCenterList(canvasOwnerSession as never, {
        projectUuid: PROJECT_UUID,
        page: 1,
        limit: 50,
      });
      const row = listed.data.find((item) => item.rowKey === `${PROJECT_UUID}+${runUuid}` || item.rowKey === `${PROJECT_UUID}:${runUuid}`);
      if (
        !row
        || !["failed", "生成失败"].includes(String(row.state))
        || !String(row.reason ?? "").includes("VENDOR_BALANCE_EMPTY_42")
      ) {
        console.error(SENTINEL);
        assert.equal(Boolean(row), true, SENTINEL);
        assert.match(String(row?.reason ?? ""), /VENDOR_BALANCE_EMPTY_42/, SENTINEL);
      }
    } finally {
      await close();
    }
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { taskCenterList } from "../../src/tianjiang/tasks/task-center-service";
import {
  canvasCatalogItem,
  canvasOwnerSession,
  mountCanvasRuntimeApp,
  stubOpenedCanvas,
} from "./helpers/canvas-crash-harness";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";

const SENTINEL = "RED_EXPECTED:CANVAS_TASK_CENTER_CROSS_PROJECT";
const PROJECT_A = "018f3d6e-2d9e-7b6c-8a9b-000000001081";
const PROJECT_B = "018f3d6e-2d9e-7b6c-8a9b-000000001082";
const NODE_A = "018f3d6e-2d9e-7b6c-8a9b-000000001083";

async function confirmOn(port: number, projectUuid: string, nodeUuid: string, clientRequestId: string): Promise<string> {
  const document = emptyCanvasDocument();
  document.graph.nodes = [{
    nodeUuid,
    kind: "image_generation",
    position: { x: 4, y: 4 },
    zIndex: 1,
    collapsed: false,
    data: { title: "出图", prompt: "跨项目" },
  }];
  await fetch(`http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${projectUuid}/canvas/document`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: 0,
      clientMutationId: "018f3d6e-2d9e-7b6c-8a9b-000000001084",
      document,
    }),
  });
  const preview = await (await fetch(
    `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${projectUuid}/canvas/executions/preview`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 1, nodeUuids: [nodeUuid] }),
    },
  )).json() as { data?: { confirmationUuid?: string; requestDigest?: string } };
  const confirmed = await (await fetch(
    `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${projectUuid}/canvas/executions/confirm`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        confirmationUuid: preview.data?.confirmationUuid,
        requestDigest: preview.data?.requestDigest,
        baseRevision: 1,
        clientRequestId,
      }),
    },
  )).json() as { data?: { runs?: Array<{ runUuid?: string }> } };
  return String(confirmed.data?.runs?.[0]?.runUuid ?? "");
}

test("openA 后台任务在 openB 后完成必须仍出现在任务中心", async () => {
  await runWithTemporaryAccount("canvas-task-center-cross", async () => {
    await initializeCanvasWorkspace(PROJECT_A);
    await initializeCanvasWorkspace(PROJECT_B);
    await stubOpenedCanvas(PROJECT_A, { name: "画布A" });
    const { syncCoordinator } = await import("../../src/tianjiang/runtime/runtime");
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const runUuid = await confirmOn(port, PROJECT_A, NODE_A, "018f3d6e-2d9e-7b6c-8a9b-000000001085");
      const { ingestCanvasProviderEvent } = await import("../../src/tianjiang/canvas/canvas-execution-events");
      await ingestCanvasProviderEvent({
        eventId: "cross-running",
        runId: runUuid,
        projectUuid: PROJECT_A,
        providerId: "fake-provider",
        accountId: "7601",
        deviceUuid: "origin",
        sequence: 1,
        occurredAt: new Date().toISOString(),
        schemaVersion: 1,
        status: "running",
      });
      Object.assign(syncCoordinator, {
        listProjects: () => [
          canvasCatalogItem(PROJECT_A, "画布A"),
          canvasCatalogItem(PROJECT_B, "画布B"),
        ],
        isProjectOpened: (uuid: string) => uuid === PROJECT_B,
      });
      await ingestCanvasProviderEvent({
        eventId: "cross-done",
        runId: runUuid,
        projectUuid: PROJECT_A,
        providerId: "fake-provider",
        accountId: "7601",
        deviceUuid: "origin",
        sequence: 2,
        occurredAt: new Date().toISOString(),
        schemaVersion: 1,
        status: "succeeded",
      });
      const listed = taskCenterList(canvasOwnerSession as never, { page: 1, limit: 50 });
      const row = listed.data.find((item) => item.rowKey === `${PROJECT_A}+${runUuid}` || item.rowKey === `${PROJECT_A}:${runUuid}`);
      if (!row || !["completed", "succeeded", "已完成"].includes(String(row.state))) {
        console.error(SENTINEL);
        assert.equal(Boolean(row), true, SENTINEL);
        assert.equal(["completed", "succeeded", "已完成"].includes(String(row?.state)), true, SENTINEL);
      }
    } finally {
      await close();
    }
  });
});

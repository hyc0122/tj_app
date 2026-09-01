import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import { mountCanvasRuntimeApp, stubOpenedCanvas } from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:CANVAS_EXECUTION_EVENTS";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000001011";
const NODE_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000001012";

function eventsModulePath(): string {
  return path.resolve(
    __dirname,
    "../../src/tianjiang/canvas/canvas-execution-events.ts",
  );
}

test("重复与乱序事件不得重复应用或状态倒退，崩溃后可重放", async () => {
  if (!fs.existsSync(eventsModulePath())) {
    console.error(SENTINEL);
    assert.fail(SENTINEL);
  }
  await runWithTemporaryAccount("canvas-execution-events", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const document = emptyCanvasDocument();
      document.graph.nodes = [{
        nodeUuid: NODE_UUID,
        kind: "image_generation",
        position: { x: 1, y: 1 },
        zIndex: 1,
        collapsed: false,
        data: { title: "出图", prompt: "春日" },
      }];
      await fetch(`http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/document`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRevision: 0,
          clientMutationId: "018f3d6e-2d9e-7b6c-8a9b-000000001013",
          document,
        }),
      });
      const preview = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseRevision: 1, nodeUuids: [NODE_UUID] }),
        },
      );
      const previewBody = await preview.json() as { data?: { confirmationUuid?: string; requestDigest?: string } };
      const confirmed = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirmationUuid: previewBody.data?.confirmationUuid,
            requestDigest: previewBody.data?.requestDigest,
            baseRevision: 1,
            clientRequestId: "018f3d6e-2d9e-7b6c-8a9b-000000001014",
          }),
        },
      );
      const receipt = await confirmed.json() as { data?: { runs?: Array<{ runUuid?: string; state?: string }> } };
      const runUuid = String(receipt.data?.runs?.[0]?.runUuid ?? "");
      const listed = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions`,
      );
      const listedBody = await listed.json().catch(() => ({})) as {
        data?: { runs?: Array<{ runUuid?: string; state?: string; sequence?: number }> };
      };
      const { ingestCanvasProviderEvent } = await import("../../src/tianjiang/canvas/canvas-execution-events");
      const first = await ingestCanvasProviderEvent({
        eventId: "evt-1",
        runId: runUuid,
        projectUuid: PROJECT_UUID,
        providerId: "fake-provider",
        accountId: "7601",
        deviceUuid: "origin",
        sequence: 2,
        occurredAt: new Date().toISOString(),
        schemaVersion: 1,
        status: "running",
      });
      const dup = await ingestCanvasProviderEvent({
        eventId: "evt-1",
        runId: runUuid,
        projectUuid: PROJECT_UUID,
        providerId: "fake-provider",
        accountId: "7601",
        deviceUuid: "origin",
        sequence: 2,
        occurredAt: new Date().toISOString(),
        schemaVersion: 1,
        status: "running",
      });
      await ingestCanvasProviderEvent({
        eventId: "evt-0",
        runId: runUuid,
        projectUuid: PROJECT_UUID,
        providerId: "fake-provider",
        accountId: "7601",
        deviceUuid: "origin",
        sequence: 1,
        occurredAt: new Date().toISOString(),
        schemaVersion: 1,
        status: "queued",
      });
      const replayUnacked = await ingestCanvasProviderEvent({
        eventId: "evt-2",
        runId: runUuid,
        projectUuid: PROJECT_UUID,
        providerId: "fake-provider",
        accountId: "7601",
        deviceUuid: "origin",
        sequence: 3,
        occurredAt: new Date().toISOString(),
        schemaVersion: 1,
        status: "succeeded",
        ack: false,
      });
      const replayAgain = await ingestCanvasProviderEvent({
        eventId: "evt-2",
        runId: runUuid,
        projectUuid: PROJECT_UUID,
        providerId: "fake-provider",
        accountId: "7601",
        deviceUuid: "origin",
        sequence: 3,
        occurredAt: new Date().toISOString(),
        schemaVersion: 1,
        status: "succeeded",
      });
      const after = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/executions`,
      );
      const afterBody = await after.json() as { data?: { runs?: Array<{ runUuid?: string; state?: string }> } };
      const run = afterBody.data?.runs?.find((item) => item.runUuid === runUuid);
      if (
        listed.status !== 200
        || confirmed.status !== 202
        || first.applied !== true
        || dup.duplicate !== true
        || replayUnacked.applied !== true
        || replayAgain.duplicate !== true
        || run?.state !== "succeeded"
      ) {
        console.error(SENTINEL);
        assert.equal(listed.status, 200, SENTINEL);
        assert.equal(dup.duplicate, true, SENTINEL);
        assert.equal(run?.state, "succeeded", SENTINEL);
      }
    } finally {
      await close();
    }
  });
});

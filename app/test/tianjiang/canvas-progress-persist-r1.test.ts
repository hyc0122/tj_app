import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithProjectStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import { mountCanvasRuntimeApp, stubOpenedCanvas } from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:CANVAS_PROGRESS_PERSIST";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000001061";
const NODE_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000001062";

async function confirmRun(port: number): Promise<string> {
  const document = emptyCanvasDocument();
  document.graph.nodes = [{
    nodeUuid: NODE_UUID,
    kind: "image_generation",
    position: { x: 1, y: 1 },
    zIndex: 1,
    collapsed: false,
    data: { title: "出图", prompt: "进度" },
  }];
  await fetch(`http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/document`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: 0,
      clientMutationId: "018f3d6e-2d9e-7b6c-8a9b-000000001063",
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
        clientRequestId: "018f3d6e-2d9e-7b6c-8a9b-000000001064",
      }),
    },
  )).json() as { data?: { runs?: Array<{ runUuid?: string }> } };
  return String(confirmed.data?.runs?.[0]?.runUuid ?? "");
}

test("进度事件最多每30秒落盘一次，关键状态立即落盘", async () => {
  const srcPath = path.resolve(
    __dirname,
    "../../src/tianjiang/canvas/canvas-execution-events.ts",
  );
  let src = "";
  try {
    src = fs.readFileSync(srcPath, "utf8");
  } catch {
    console.error(SENTINEL);
    assert.fail(SENTINEL);
  }
  if (!src.includes("30_000") && !src.includes("30 * 1000") && !src.includes("PROGRESS_PERSIST_INTERVAL_MS")) {
    console.error(SENTINEL);
    assert.equal(src.includes("PROGRESS_PERSIST_INTERVAL_MS"), true, SENTINEL);
  }
  await runWithTemporaryAccount("canvas-progress-persist", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const runUuid = await confirmRun(port);
      const events = await import("../../src/tianjiang/canvas/canvas-execution-events");
      events.setCanvasProgressClock?.(() => 1_000);
      await events.ingestCanvasProviderEvent({
        eventId: "prog-queued",
        runId: runUuid,
        projectUuid: PROJECT_UUID,
        providerId: "fake-provider",
        accountId: "7601",
        deviceUuid: "origin",
        sequence: 1,
        occurredAt: new Date(1_000).toISOString(),
        schemaVersion: 1,
        status: "queued",
      });
      await events.ingestCanvasProviderEvent({
        eventId: "prog-running",
        runId: runUuid,
        projectUuid: PROJECT_UUID,
        providerId: "fake-provider",
        accountId: "7601",
        deviceUuid: "origin",
        sequence: 2,
        occurredAt: new Date(1_000).toISOString(),
        schemaVersion: 1,
        status: "running",
        progress: 1,
      });
      for (let index = 2; index <= 6; index += 1) {
        await events.ingestCanvasProviderEvent({
          eventId: `prog-${index}`,
          runId: runUuid,
          projectUuid: PROJECT_UUID,
          providerId: "fake-provider",
          accountId: "7601",
          deviceUuid: "origin",
          sequence: index + 1,
          occurredAt: new Date(1_000 + index).toISOString(),
          schemaVersion: 1,
          status: "running",
          progress: index * 10,
        });
      }
      events.setCanvasProgressClock?.(() => 1_000 + 30_000);
      await events.ingestCanvasProviderEvent({
        eventId: "prog-late",
        runId: runUuid,
        projectUuid: PROJECT_UUID,
        providerId: "fake-provider",
        accountId: "7601",
        deviceUuid: "origin",
        sequence: 20,
        occurredAt: new Date(31_000).toISOString(),
        schemaVersion: 1,
        status: "running",
        progress: 80,
      });
      await events.ingestCanvasProviderEvent({
        eventId: "prog-failed",
        runId: runUuid,
        projectUuid: PROJECT_UUID,
        providerId: "fake-provider",
        accountId: "7601",
        deviceUuid: "origin",
        sequence: 21,
        occurredAt: new Date(31_100).toISOString(),
        schemaVersion: 1,
        status: "failed",
        failureText: "fake-provider 拒绝",
      });
      const { db } = await import("../../src/utils/db");
      const rows = await runWithProjectStorage(PROJECT_UUID, () => db("canvas_execution_events").where({ run_uuid: runUuid }));
      const ids = rows.map((row) => String(row.provider_event_id));
      const rawInbox = await import("../../src/tianjiang/canvas/canvas-provider-raw-inbox");
      const throttledRaw = rawInbox.listRawInboxRecords()
        .filter((row) => /^prog-[2-6]$/.test(row.eventId)) as Array<{ eventId: string; state?: string }>;
      if (
        ids.includes("prog-2")
        || ids.includes("prog-3")
        || ids.includes("prog-4")
        || ids.includes("prog-5")
        || ids.includes("prog-6")
        || !ids.includes("prog-queued")
        || !ids.includes("prog-running")
        || !ids.includes("prog-late")
        || !ids.includes("prog-failed")
        || throttledRaw.length !== 5
        || throttledRaw.some((row) => row.state !== "processed")
      ) {
        console.error(SENTINEL);
        assert.equal(ids.includes("prog-2"), false, SENTINEL);
        assert.equal(ids.includes("prog-queued"), true, SENTINEL);
        assert.equal(ids.includes("prog-failed"), true, SENTINEL);
        assert.equal(throttledRaw.length, 5, SENTINEL);
        assert.equal(throttledRaw.every((row) => row.state === "processed"), true, SENTINEL);
      }
    } finally {
      await close();
    }
  });
});

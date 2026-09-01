import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import { mountCanvasRuntimeApp, ONE_PIXEL_PNG, stubOpenedCanvas } from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:CANVAS_PROVIDER_RESULT_ASSET";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000001021";
const NODE_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000001022";

test("结果素材必须登记为 assetUuid，节点不得保存 Provider URL", async () => {
  const target = path.resolve(
    __dirname,
    "../../src/tianjiang/canvas/canvas-execution-events.ts",
  );
  if (!fs.existsSync(target)) {
    console.error(SENTINEL);
    assert.fail(SENTINEL);
  }
  await runWithTemporaryAccount("canvas-result-asset", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const document = emptyCanvasDocument();
      document.graph.nodes = [{
        nodeUuid: NODE_UUID,
        kind: "image_generation",
        position: { x: 2, y: 2 },
        zIndex: 1,
        collapsed: false,
        data: { title: "出图", prompt: "庭院" },
      }];
      await fetch(`http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/document`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRevision: 0,
          clientMutationId: "018f3d6e-2d9e-7b6c-8a9b-000000001023",
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
            clientRequestId: "018f3d6e-2d9e-7b6c-8a9b-000000001024",
          }),
        },
      )).json() as { data?: { runs?: Array<{ runUuid?: string }> } };
      const { ingestCanvasProviderEvent } = await import("../../src/tianjiang/canvas/canvas-execution-events");
      const applied = await ingestCanvasProviderEvent({
        eventId: "asset-1",
        runId: String(confirmed.data?.runs?.[0]?.runUuid),
        projectUuid: PROJECT_UUID,
        providerId: "fake-provider",
        accountId: "7601",
        deviceUuid: "origin",
        sequence: 1,
        occurredAt: new Date().toISOString(),
        schemaVersion: 1,
        status: "succeeded",
        resultBytes: ONE_PIXEL_PNG,
        resultMime: "image/png",
        providerUrl: "https://cdn.example/secret-result.png?token=AKIA",
      });
      const doc = await (await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/document`,
      )).json() as { data?: { document?: { graph?: { nodes?: Array<{ data?: Record<string, unknown> }> } } } };
      const nodeData = JSON.stringify(doc.data?.document?.graph?.nodes ?? []);
      if (!applied.assetUuid || nodeData.includes("https://") || nodeData.includes("AKIA")) {
        console.error(SENTINEL);
        assert.equal(Boolean(applied.assetUuid), true, SENTINEL);
        assert.equal(nodeData.includes("https://"), false, SENTINEL);
      }
    } finally {
      await close();
    }
  });
});

/**
 * 真实子进程：确认收费执行后进入 failpoint，供父进程硬杀。
 */
import fs from "node:fs";

import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "../tianjiang/helpers/worktree-runtime";
import { mountCanvasRuntimeApp, stubOpenedCanvas } from "../tianjiang/helpers/canvas-crash-harness";

const projectUuid = String(process.env.CANVAS_CRASH_PROJECT_UUID ?? "");
const markerPath = String(process.env.CANVAS_CRASH_MARKER ?? "");
const nodeUuid = "018f3d6e-2d9e-7b6c-8a9b-000000000f01";

function mark(state: string): void {
  if (!markerPath) return;
  fs.writeFileSync(markerPath, state, "utf8");
}

async function main(): Promise<void> {
  mark("started");
  await runWithTemporaryAccount("canvas-paid-boundary-child", async () => {
    await initializeCanvasWorkspace(projectUuid);
    await stubOpenedCanvas(projectUuid);
    const { port, close } = await mountCanvasRuntimeApp();
    try {
      const document = emptyCanvasDocument();
      document.graph.nodes = [{
        nodeUuid,
        kind: "image_generation",
        position: { x: 1, y: 1 },
        zIndex: 1,
        collapsed: false,
        data: { title: "出图", prompt: "春日" },
      }];
      await fetch(`http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${projectUuid}/canvas/document`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRevision: 0,
          clientMutationId: "018f3d6e-2d9e-7b6c-8a9b-000000000f02",
          document,
        }),
      });
      const preview = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${projectUuid}/canvas/executions/preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseRevision: 1, nodeUuids: [nodeUuid] }),
        },
      );
      const previewBody = await preview.json() as { data?: { confirmationUuid?: string; requestDigest?: string } };
      mark("confirming");
      const accepted = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${projectUuid}/canvas/executions/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirmationUuid: previewBody.data?.confirmationUuid,
            requestDigest: previewBody.data?.requestDigest,
            baseRevision: 1,
            clientRequestId: "018f3d6e-2d9e-7b6c-8a9b-000000000f03",
          }),
        },
      );
      fs.writeFileSync(`${markerPath}.json`, JSON.stringify({ status: accepted.status }), "utf8");
      mark(`http:${accepted.status}`);
      if (process.env.CANVAS_FAILPOINT === "after-confirm") {
        await new Promise(() => undefined);
      }
    } finally {
      await close();
    }
  });
  mark("exited");
}

main().catch((error) => {
  mark(`error:${error instanceof Error ? error.message : "unknown"}`);
  process.exit(1);
});

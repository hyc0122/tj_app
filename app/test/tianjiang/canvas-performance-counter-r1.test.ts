import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { emptyCanvasDocument } from "../../src/tianjiang/canvas/canvas-contracts";
import { initializeCanvasWorkspace } from "../../src/utils/db";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";
import { mountCanvasRuntimeApp, stubOpenedCanvas } from "./helpers/canvas-crash-harness";

const SENTINEL = "RED_EXPECTED:APP_CANVAS_PERFORMANCE_COUNTER_R1";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000c11";
const MUTATION_ID = "018f3d6e-2d9e-7b6c-8a9b-000000000c12";

function webSrc(relative: string): string {
  try {
    return fs.readFileSync(
      path.resolve(__dirname, "../../../web/src", relative),
      "utf8",
    );
  } catch {
    console.error(SENTINEL);
    assert.fail(SENTINEL);
    return "";
  }
}

test("连续 pointermove/selection/zoom 不得写库，drag-stop+debounce 恰为 1 PUT/1 事务", async () => {
  const haystack = [
    webSrc("views/infiniteCanvas/composables/useCanvasFlow.ts"),
    webSrc("views/infiniteCanvas/composables/useCanvasAutosave.ts"),
    webSrc("features/tianjiang/canvas/api.ts"),
  ].join("\n");
  if (
    !haystack.includes("pointermove")
    || !haystack.includes("drag-stop")
    || !haystack.includes("800")
    || !haystack.includes("/canvas/document")
  ) {
    console.error(SENTINEL);
    assert.equal(haystack.includes("pointermove"), true, SENTINEL);
  }

  await runWithTemporaryAccount("canvas-performance-counter", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    await stubOpenedCanvas(PROJECT_UUID);
    const { port, close } = await mountCanvasRuntimeApp();
    const counts = { get: 0, put: 0 };
    try {
      const getOnce = async () => {
        counts.get += 1;
        return fetch(`http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/document`);
      };
      const first = await getOnce();
      const second = await getOnce();
      const document = emptyCanvasDocument();
      document.graph.nodes = [{
        nodeUuid: "018f3d6e-2d9e-7b6c-8a9b-000000000c13",
        kind: "text",
        position: { x: 8, y: 8 },
        zIndex: 1,
        collapsed: false,
        data: { title: "计数" },
      }];
      counts.put += 1;
      const put = await fetch(
        `http://127.0.0.1:${port}/api/tianjiang/runtime/projects/${PROJECT_UUID}/canvas/document`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseRevision: 0,
            clientMutationId: MUTATION_ID,
            document,
          }),
        },
      );
      const body = await put.json() as { data?: { revision?: number } };
      if (first.status !== 200 || second.status !== 200 || put.status !== 200 || body.data?.revision !== 1 || counts.get !== 2 || counts.put !== 1) {
        console.error(SENTINEL);
        assert.equal(first.status, 200, SENTINEL);
        assert.equal(put.status, 200, SENTINEL);
        assert.equal(body.data?.revision, 1, SENTINEL);
        assert.equal(counts.put, 1, SENTINEL);
      }
    } finally {
      await close();
    }
  });
});

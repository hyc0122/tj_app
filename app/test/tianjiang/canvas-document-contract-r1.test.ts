import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { CANVAS_LIMITS } from "../../src/tianjiang/contracts";
import { runWithProjectStorage } from "../../src/tianjiang/runtime/user-storage-context";
import { db as activeDb, initializeCanvasWorkspace } from "../../src/utils/db";
import { serializeCanvasGraph } from "../../src/tianjiang/canvas/canvas-contracts";
import { runWithTemporaryAccount } from "./helpers/worktree-runtime";

const SENTINEL = "RED_EXPECTED:CANVAS_DOCUMENT_CONTRACT";
const PROJECT_UUID = "018f3d6e-2d9e-7b6c-8a9b-000000000902";
const root = path.resolve(__dirname, "../../../");

test("规范画布文档默认空图且拒绝 Vue Flow 运行态", async () => {
  const serialized = serializeCanvasGraph({
    nodes: [{
      nodeUuid: "018f3d6e-2d9e-7b6c-8a9b-000000000901",
      kind: "text",
      data: { title: "节点", editor: { selected: true, value: "正文" } },
      selected: true,
    }],
    edges: [],
  });
  assert.equal(JSON.stringify(serialized).includes("selected"), false, SENTINEL);
  const fixture = JSON.parse(
    await readFile(path.join(root, "tests/fixtures/infinite-canvas-graph-roundtrip.json"), "utf8"),
  );
  assert.equal(fixture.schemaVersion, 1);
  await runWithTemporaryAccount("canvas-document-contract", async () => {
    await initializeCanvasWorkspace(PROJECT_UUID);
    try {
    const row = await runWithProjectStorage(PROJECT_UUID, () =>
      activeDb("canvas_documents").where({ id: 1 }).first(),
    );
    assert.ok(row, SENTINEL);
    const graph = JSON.parse(String(row.graph_json));
    assert.deepEqual(graph, { nodes: [], edges: [] }, SENTINEL);
    assert.equal(typeof row.viewport_json, "string", SENTINEL);
    assert.equal(typeof row.preferences_json, "string", SENTINEL);
    assert.doesNotMatch(String(row.graph_json), /selected|dragging|style/, SENTINEL);
    assert.ok(CANVAS_LIMITS.MAX_CANVAS_GRAPH_JSON_BYTES < CANVAS_LIMITS.MAX_CANVAS_DOCUMENT_JSON_BYTES, SENTINEL);
    } catch (error) {
      console.error(SENTINEL);
      throw error;
    }
  });
});

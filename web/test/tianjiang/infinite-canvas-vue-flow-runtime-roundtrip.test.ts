// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CANVAS_NODE_KIND_VALUES } from "@/features/tianjiang/contracts";
import { serializeCanvasDocument } from "@/features/tianjiang/canvas/document";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_VUE_FLOW_RUNTIME_ROUNDTRIP";

function webSrc(relative: string): string {
  try {
    return readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src", relative),
      "utf8",
    );
  } catch {
    console.error(SENTINEL);
    expect.fail(SENTINEL);
    return "";
  }
}

describe("Vue Flow 规范图两轮 round-trip", () => {
  it("共享夹具序列化后不得带入 Vue Flow 运行态字段", () => {
    const fixture = JSON.parse(readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures/infinite-canvas-graph-roundtrip.json"),
      "utf8",
    ));
    const serialized = serializeCanvasDocument({
      ...fixture,
      graph: {
        nodes: fixture.graph.nodes.map((node: Record<string, unknown>) => ({
          ...node,
          selected: true,
          dragging: true,
        })),
        edges: fixture.graph.edges,
      },
    });
    const blob = JSON.stringify(serialized);
    if (blob.includes('"selected"') || blob.includes('"dragging"') || serialized.viewport.zoom !== 1) {
      console.error(SENTINEL);
      expect(blob.includes('"selected"'), SENTINEL).toBe(false);
      expect(serialized.viewport.zoom, SENTINEL).toBe(1);
    }
  });

  it("编辑器必须覆盖全部节点 kind 并在复制导入时清除运行身份", () => {
    const haystack = [
      webSrc("views/infiniteCanvas/TapCanvasHost.vue"),
      webSrc("views/infiniteCanvas/composables/useCanvasFlow.ts"),
      webSrc("views/infiniteCanvas/components/CanvasViewport.vue"),
    ].join("\n");
    const missingKinds = CANVAS_NODE_KIND_VALUES.filter((kind) => !haystack.includes(kind));
    const runtimeCleared = ["runUuid", "taskUuid", "confirmationUuid", "currentRun", "latestRun"]
      .every((field) => haystack.includes(field));
    if (missingKinds.length !== 0 || !runtimeCleared) {
      console.error(SENTINEL);
      expect(missingKinds, SENTINEL).toEqual([]);
      expect(runtimeCleared, SENTINEL).toBe(true);
    }
  });
});

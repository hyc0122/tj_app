import { MAX_CANVAS_GROUP_DEPTH } from "./limits";
import type { CanvasDocument } from "./types";

const RUNTIME_KEYS = new Set([
  "selected", "dragging", "resizing", "style", "class", "events",
  "measured", "dimensions", "initialized", "handleBounds",
]);

export function serializeCanvasDocument(document: CanvasDocument): CanvasDocument {
  return {
    schemaVersion: 1,
    graph: {
      nodes: (document.graph?.nodes ?? []).map(stripRuntime),
      edges: (document.graph?.edges ?? []).map(stripRuntime),
    },
    viewport: document.viewport,
    preferences: document.preferences,
  };
}

function stripRuntime(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (RUNTIME_KEYS.has(key)) continue;
    result[key] = item;
  }
  return result;
}

export function assertGroupDepth(nodes: Array<{ parentNodeUuid?: string }>): void {
  const byId = new Map(nodes.map((node) => [String((node as { nodeUuid?: string }).nodeUuid), node]));
  for (const node of nodes) {
    let depth = 0;
    let current = node.parentNodeUuid;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current)) throw new Error("分组存在循环");
      seen.add(current);
      depth += 1;
      if (depth > MAX_CANVAS_GROUP_DEPTH) throw new Error("分组深度超过上限");
      current = byId.get(current)?.parentNodeUuid;
    }
  }
}

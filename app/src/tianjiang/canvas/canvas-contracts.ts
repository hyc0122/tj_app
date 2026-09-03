import {
  CANVAS_DTO_FIELDS,
  CANVAS_LIMITS,
  type CanvasEdgeKind,
  type CanvasNodeKind,
} from "../contracts";

export interface CanvasNode {
  nodeUuid?: string;
  kind?: CanvasNodeKind | string;
  position?: { x: number; y: number };
  zIndex?: number;
  collapsed?: boolean;
  parentNodeUuid?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CanvasEdge {
  edgeUuid?: string;
  kind?: CanvasEdgeKind | string;
  sourceNodeUuid?: string;
  targetNodeUuid?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CanvasGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface CanvasDocument {
  schemaVersion: 1;
  graph: CanvasGraph;
  viewport: { x: number; y: number; zoom: number };
  preferences: { wheelMode: "zoom" | "pan"; snapToGrid: boolean; gridSize: number };
  /** 中文注释：TapCanvas 一句话成片的可恢复进度，必须随文档修订一起持久化。 */
  sceneCreationProgress?: unknown;
}

const RUNTIME_KEYS = new Set([
  "selected", "dragging", "resizing", "style", "class", "events",
  "measured", "dimensions", "initialized", "handleBounds",
]);

/** 只保留规范业务字段，剔除 Vue Flow 运行态。 */
export function serializeCanvasGraph(input: { nodes?: unknown[]; edges?: unknown[] }): {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
} {
  const nodes = Array.isArray(input.nodes)
    ? input.nodes.map(stripRuntime).filter(isRecord) as CanvasNode[]
    : [];
  const edges = Array.isArray(input.edges)
    ? input.edges.map(stripRuntime).filter(isRecord) as CanvasEdge[]
    : [];
  return { nodes, edges };
}

function stripRuntime(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripRuntime);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (RUNTIME_KEYS.has(key)) continue;
    result[key] = stripRuntime(item);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function emptyCanvasDocument(): CanvasDocument {
  return {
    schemaVersion: 1,
    graph: { nodes: [], edges: [] },
    viewport: { x: 0, y: 0, zoom: 1 },
    preferences: { wheelMode: "zoom", snapToGrid: true, gridSize: 16 },
    sceneCreationProgress: null,
  };
}

export const canvasNodeKinds = CANVAS_DTO_FIELDS.CanvasNode;
export const canvasEdgeKinds = CANVAS_DTO_FIELDS.CanvasEdge;
export const canvasLimits = CANVAS_LIMITS;

export type { CanvasNodeKind, CanvasEdgeKind };

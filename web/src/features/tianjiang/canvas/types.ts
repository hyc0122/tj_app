import {
  CANVAS_DTO_FIELDS,
  type CanvasEdgeKind,
  type CanvasNodeKind,
} from "@/features/tianjiang/contracts";

export type { CanvasEdgeKind, CanvasNodeKind };

export interface CanvasDocument {
  schemaVersion: 1;
  graph: { nodes: unknown[]; edges: unknown[] };
  viewport: { x: number; y: number; zoom: number };
  preferences: { wheelMode: "zoom" | "pan"; snapToGrid: boolean; gridSize: number };
}

export const canvasNodeFields = CANVAS_DTO_FIELDS.CanvasNode;
export const canvasEdgeFields = CANVAS_DTO_FIELDS.CanvasEdge;

export type CanvasLayoutMode = "grid" | "vertical" | "flow";

export function layoutCanvasNodes(
  nodes: Array<{ position: { x: number; y: number } }>,
  mode: CanvasLayoutMode,
): Array<{ position: { x: number; y: number } }> {
  return nodes.map((node, index) => {
    if (mode === "vertical") return { position: { x: node.position.x, y: index * 120 } };
    if (mode === "flow") return { position: { x: index * 160, y: index * 40 } };
    const column = index % 8;
    const row = Math.floor(index / 8);
    return { position: { x: column * 200, y: row * 140 } };
  });
}

export function createLayoutRequestId(): string {
  return crypto.randomUUID();
}

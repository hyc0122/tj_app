import { CANVAS_HISTORY_LIMIT } from "./limits";
import type { CanvasDocument } from "./types";

export interface CanvasTransaction {
  label: string;
  before: CanvasDocument;
  after: CanvasDocument;
}

export function createCanvasHistory() {
  const undoStack: CanvasTransaction[] = [];
  const redoStack: CanvasTransaction[] = [];
  return {
    limit: CANVAS_HISTORY_LIMIT,
    push(transaction: CanvasTransaction): void {
      undoStack.push(transaction);
      if (undoStack.length > CANVAS_HISTORY_LIMIT) undoStack.shift();
      redoStack.length = 0;
    },
    undo(): CanvasTransaction | undefined {
      const item = undoStack.pop();
      if (item) redoStack.push(item);
      return item;
    },
    redo(): CanvasTransaction | undefined {
      const item = redoStack.pop();
      if (item) undoStack.push(item);
      return item;
    },
  };
}

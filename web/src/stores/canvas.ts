import { defineStore } from "pinia";
import type { CanvasDocument } from "@/features/tianjiang/canvas/types";
import { createCanvasHistory } from "@/features/tianjiang/canvas/history";
import { getCanvasDocument, putCanvasDocument } from "@/features/tianjiang/canvas/api";

export const useCanvasStore = defineStore("canvas", {
  persist: false,
  state: () => ({
    projectUuid: "",
    document: {
      schemaVersion: 1 as const,
      graph: { nodes: [], edges: [] },
      viewport: { x: 0, y: 0, zoom: 1 },
      preferences: { wheelMode: "zoom" as const, snapToGrid: true, gridSize: 16 },
    } as CanvasDocument,
    revision: 0,
    saveState: "clean" as "clean" | "dirty" | "saving" | "saved" | "conflict",
    cloudSyncState: "unknown" as "unknown" | "syncing" | "synced" | "failed",
    history: createCanvasHistory(),
  }),
  actions: {
    async open(projectUuid: string): Promise<void> {
      this.projectUuid = projectUuid;
      const envelope = await getCanvasDocument(projectUuid) as {
        data?: { revision?: number; document?: CanvasDocument };
        revision?: number;
        document?: CanvasDocument;
      };
      const payload = envelope.data ?? envelope;
      if (payload.document) this.document = payload.document;
      this.revision = Number(payload.revision ?? 0);
      this.saveState = "saved";
    },
    execute(): void {
      this.saveState = "dirty";
    },
    undo(): boolean {
      return Boolean(this.history.undo());
    },
    redo(): boolean {
      return Boolean(this.history.redo());
    },
    updateViewport(viewport: CanvasDocument["viewport"]): void {
      this.document.viewport = viewport;
    },
    async flush(): Promise<void> {
      if (!this.projectUuid || this.saveState === "clean") return;
      this.saveState = "saving";
      await putCanvasDocument(this.projectUuid, {
        baseRevision: this.revision,
        clientMutationId: crypto.randomUUID(),
        document: this.document,
      });
      this.saveState = "saved";
    },
    reset(): void {
      this.$reset();
    },
  },
});

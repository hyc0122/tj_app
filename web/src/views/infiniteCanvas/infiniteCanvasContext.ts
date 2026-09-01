import type { InjectionKey } from "vue";
import type { useInfiniteCanvasWorkspace } from "./composables/useInfiniteCanvasWorkspace";

export const infiniteCanvasContextKey: InjectionKey<ReturnType<typeof useInfiniteCanvasWorkspace>> =
  Symbol("infinite-canvas-workspace");

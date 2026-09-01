import { useCanvasStore } from "@/stores/canvas";
import { openCanvasProject, closeCanvasProject } from "@/features/tianjiang/canvas/api";

export function useInfiniteCanvasWorkspace() {
  const store = useCanvasStore();
  let activeRuntime: { projectUuid: string; runtimeGeneration: number } | null = null;

  async function open(projectUuid: string): Promise<void> {
    if (activeRuntime && activeRuntime.projectUuid !== projectUuid) {
      await store.flush();
      await closeCanvasProject(activeRuntime.projectUuid, activeRuntime.runtimeGeneration);
      activeRuntime = null;
    }
    const opened = await openCanvasProject(projectUuid);
    activeRuntime = opened;
    try {
      await store.open(projectUuid);
    } catch (error) {
      // 中文注释：文档加载失败也要按本次 open 的准确代次回收后端运行时。
      await closeCanvasProject(opened.projectUuid, opened.runtimeGeneration).catch(() => undefined);
      activeRuntime = null;
      throw error;
    }
  }

  async function close(): Promise<void> {
    if (!activeRuntime) {
      store.reset();
      return;
    }
    const closing = activeRuntime;
    activeRuntime = null;
    await store.flush();
    await closeCanvasProject(closing.projectUuid, closing.runtimeGeneration);
    store.reset();
  }
  return { open, close, store };
}

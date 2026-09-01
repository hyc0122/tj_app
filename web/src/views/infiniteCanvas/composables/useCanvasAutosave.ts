import { useCanvasStore } from "@/stores/canvas";
import { saveRecoveryDraft } from "@/features/tianjiang/canvas/recovery-draft";

export function useCanvasAutosave() {
  const store = useCanvasStore();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let draftVersion = 0;
  function schedule(): void {
    store.execute();
    draftVersion += 1;
    void saveRecoveryDraft(store.projectUuid, {
      draftVersion,
      clientMutationId: crypto.randomUUID(),
      digest: `${draftVersion}`,
      baseRevision: store.revision,
      document: store.document,
    });
    clearTimeout(timer);
    timer = setTimeout(() => {
      void store.flush();
    }, 800);
  }
  async function flushNow(): Promise<void> {
    clearTimeout(timer);
    await store.flush();
  }
  return { schedule, flushNow };
}

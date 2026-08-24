import { onMounted, type Ref } from "vue";
import { useGenerateActions } from "./useGenerateActions";
import { useGeneratePolling } from "./useGeneratePolling";
import { useGenerateState } from "./useGenerateState";

export function useGenerateWorkbench(episodesId: Ref<number>) {
  const state = useGenerateState(episodesId);
  const actions = useGenerateActions(state, episodesId);
  const polling = useGeneratePolling(state, episodesId);

  onMounted(async () => {
    state.modelParmas.value.model = state.project.value?.videoModel || "";
    state.modelParmas.value.mode = state.project.value?.mode || "";
    await state.getGenerateData();
    if (polling.generatingVideoIds.value.length > 0) {
      polling.startVideoPolling();
    }
  });

  return {
    ...state,
    ...actions,
    ...polling,
  };
}

import { onMounted, onUnmounted } from "vue";
import { useCornerScapeBatchActions } from "./useCornerScapeBatchActions";
import { useCornerScapeDrawer } from "./useCornerScapeDrawer";
import { useCornerScapePolling } from "./useCornerScapePolling";
import { useCornerScapeState } from "./useCornerScapeState";

export function useCornerScapePage() {
  const state = useCornerScapeState();
  const drawer = useCornerScapeDrawer(state);
  const batch = useCornerScapeBatchActions(state, drawer);
  const polling = useCornerScapePolling(state, drawer);

  onMounted(() => void state.getFilteredData());
  onUnmounted(() => {
    state.abortGeneration();
    state.dataList.value.forEach((item) => {
      if (item.state === "生成中") item.state = "";
    });
  });

  return { ...state, ...drawer, ...batch, ...polling };
}

export type CornerScapePageContext = ReturnType<typeof useCornerScapePage>;

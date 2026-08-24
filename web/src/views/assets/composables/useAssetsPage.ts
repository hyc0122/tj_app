import { onMounted } from "vue";
import { useAssetsBatchActions } from "./useAssetsBatchActions";
import { useAssetsColumns } from "./useAssetsColumns";
import { useAssetsItemActions } from "./useAssetsItemActions";
import { useAssetsPolling } from "./useAssetsPolling";
import { useAssetsState, type AssetsPageProps } from "./useAssetsState";

export function useAssetsPage(props: AssetsPageProps) {
  const state = useAssetsState(props);
  const batch = useAssetsBatchActions(state);
  const items = useAssetsItemActions(state);
  const polling = useAssetsPolling(state);
  const columns = useAssetsColumns(state);

  onMounted(() => {
    void state.loadCurrentTabData();
  });

  return {
    ...state,
    ...batch,
    ...items,
    ...polling,
    ...columns,
  };
}

export type AssetsPageContext = ReturnType<typeof useAssetsPage>;

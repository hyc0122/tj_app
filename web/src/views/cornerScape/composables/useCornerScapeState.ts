import { computed, ref, type Ref } from "vue";
import { storeToRefs } from "pinia";
import { DialogPlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";
import { localProjectBody, toLocalProjectId } from "@/features/tianjiang/project/local-project-id";
import projectStore from "@/stores/project";
import { selectIdsByState, selectPromptEmptyIds } from "./cornerScapeLogic";
import type { CornerScapeItem } from "./cornerScapeTypes";

export interface CornerScapeProject {
  id: string;
  imageModel: string;
}

export function useCornerScapeState() {
  const { project: projectStoreRef } = storeToRefs(projectStore());
  const project = projectStoreRef as Ref<CornerScapeProject | null>;
  const checkboxValue = ref<string[]>([]);
  const selectValue = ref(project.value?.imageModel ?? "");
  const resolution = ref("1K");
  const otherTextPrompt = ref("");
  const resolutionOptions = [
    { label: "1K", value: "1K" },
    { label: "2K", value: "2K" },
    { label: "4K", value: "4K" },
  ];
  const options = ref([
    { labelKey: "workbench.cornerScape.filterRole", value: "role" },
    { labelKey: "workbench.cornerScape.filterScene", value: "scene" },
    { labelKey: "workbench.cornerScape.filterTool", value: "tool" },
  ]);
  const translatedOptions = computed(() =>
    options.value.map((option) => ({ ...option, label: $t(option.labelKey) })),
  );
  const dataList = ref<CornerScapeItem[]>([]);
  const selectedIds = ref<number[]>([]);
  const loading = ref(false);
  let abortController: AbortController | null = null;

  function createAbortController() {
    abortController?.abort();
    abortController = new AbortController();
    return abortController;
  }

  function abortGeneration() {
    abortController?.abort();
    abortController = null;
  }

  function syncSelectedIdsWithData() {
    const visibleIds = new Set(dataList.value.map((item) => item.id));
    selectedIds.value = [...new Set(selectedIds.value)].filter((id) => visibleIds.has(id));
  }

  async function getFilteredData() {
    try {
      loading.value = true;
      const payload = await axios.post("/cornerScape/getAllAssets", {
        projectId: toLocalProjectId(project.value?.id),
        type: checkboxValue.value,
      });
      dataList.value = Array.isArray(payload) ? payload : Array.isArray((payload as { data?: unknown })?.data)
        ? (payload as { data: CornerScapeItem[] }).data
        : [];
      syncSelectedIdsWithData();
    } catch (error) {
      console.error("加载资产数据失败:", error);
      dataList.value = [];
      selectedIds.value = [];
    } finally {
      loading.value = false;
    }
  }

  const previewImages = computed(() => {
    const selected = dataList.value
      .filter((item) => selectedIds.value.includes(item.id) && item.filePath)
      .map((item) => item.filePath as string);
    return selected.length
      ? selected
      : dataList.value.filter((item) => item.filePath).map((item) => item.filePath as string);
  });
  const hasPreviewImages = computed(() => previewImages.value.length > 0);

  function toggleSelect(id: number) {
    const index = selectedIds.value.indexOf(id);
    if (index === -1) selectedIds.value.push(id);
    else selectedIds.value.splice(index, 1);
  }
  function selectByState(state: string) {
    selectedIds.value = selectIdsByState(dataList.value, state);
  }
  function selectPromptEmpty() {
    const ids = selectPromptEmptyIds(dataList.value);
    if (!ids.length) {
      window.$message.warning($t("workbench.cornerScape.noEmptyPrompt"));
      return;
    }
    selectedIds.value = ids;
    window.$message.success($t("workbench.cornerScape.selectedCount", { count: ids.length }));
  }
  function selectAll() {
    selectedIds.value = dataList.value.map((item) => item.id);
  }
  function toggleSelectAll() {
    selectedIds.value = selectedIds.value.length === dataList.value.length
      ? []
      : dataList.value.map((item) => item.id);
  }
  function clearSelection() {
    selectedIds.value = [];
  }

  async function cancelGenerationFn(item: CornerScapeItem) {
    const dialog = DialogPlugin.confirm({
      header: $t("workbench.assets.confirmCancellation"),
      body: $t("workbench.assets.confirmAgain"),
      confirmBtn: $t("workbench.assets.sure"),
      cancelBtn: $t("workbench.assets.cancelBtn"),
      theme: "warning",
      onConfirm: async () => {
        try {
          const { data } = await axios.post("/cornerScape/getAllAssets", {
            projectId: toLocalProjectId(project.value?.id),
            type: checkboxValue.value,
          });
          const freshItem = (data as CornerScapeItem[]).find((entry) => entry.id === item.id);
          if (!freshItem?.imageId) {
            window.$message.warning($t("workbench.cornerScape.noGenerating"));
            return;
          }
          await axios.post("/assetsGenerate/cancelGenerate", { id: freshItem.imageId });
          window.$message.success(`${$t("workbench.cornerScape.cancelGeneration")} ${item.name}`);
        } catch (error) {
          window.$message.error((error as Error)?.message ?? `${$t("workbench.cornerScape.cancelGeneration")}失败`);
        } finally {
          void getFilteredData();
          dialog.destroy();
        }
      },
    });
  }

  return {
    project, checkboxValue, selectValue, resolution, otherTextPrompt, resolutionOptions,
    translatedOptions, dataList, selectedIds, loading, createAbortController, abortGeneration,
    getFilteredData, previewImages, hasPreviewImages, toggleSelect, selectByState,
    selectPromptEmpty, selectAll, toggleSelectAll, clearSelection, cancelGenerationFn,
    onChangeFn: getFilteredData,
  };
}

export type CornerScapeState = ReturnType<typeof useCornerScapeState>;

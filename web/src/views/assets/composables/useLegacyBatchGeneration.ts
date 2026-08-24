import { computed, ref, watch, type Ref } from "vue";
import { storeToRefs } from "pinia";
import type { TableProps } from "tdesign-vue-next";
import axios from "@/utils/axios";
import { localProjectBody, toLocalProjectId } from "@/features/tianjiang/project/local-project-id";
import projectStore from "@/stores/project";
import settingStore from "@/stores/setting";

interface AssetItem {
  id: number;
  name: string;
  prompt: string;
  type?: string;
  describe?: string;
  filePath?: string;
  remark?: string;
}

export function useLegacyBatchGeneration(
  type: "role" | "tool" | "scene" | "clip",
  visible: Ref<boolean>,
  emitUpdate: () => void,
) {
  const { project } = storeToRefs(projectStore());
  const { otherSetting } = storeToRefs(settingStore());
  const tableData = ref<AssetItem[]>([]);
  const localData = ref<AssetItem[]>([]);
  const rowPromptLoading = ref<Record<number, boolean>>({});
  const rowImageLoading = ref<Record<number, boolean>>({});
  const selectedRowKeys = ref<Array<string | number>>([]);
  const searchText = ref("");
  const loading = ref(false);
  const textLoading = ref(false);
  const imageLoading = ref(false);
  const promptGenerateCancel = ref(false);
  const imageGenerateCancel = ref(false);
  const pagination = ref({ current: 1, pageSize: 10, total: 0 });
  const filteredData = computed(() => tableData.value);
  const columns: TableProps["columns"] = [
    { colKey: "row-select", type: "multiple", width: 50, align: "center", fixed: "left" },
    {
      colKey: "filePath",
      title: $t("workbench.assets.batch.colPreviewImg"),
      width: 100,
      align: "center",
      cell: "preview",
    },
    {
      colKey: "name",
      title: $t("workbench.assets.colName"),
      width: 150,
      align: "left",
      ellipsis: true,
    },
    {
      colKey: "prompt",
      title: $t("workbench.assets.colPrompt"),
      minWidth: 200,
      align: "left",
      ellipsis: true,
      cell: "prompt",
    },
  ];

  function handleSelectChange(value: Array<string | number>) {
    selectedRowKeys.value = value;
  }
  function handleSelectAll() {
    selectedRowKeys.value = filteredData.value.map((item) => item.id);
  }
  function handleClearSelection() {
    selectedRowKeys.value = [];
  }

  async function handlePageChange(pageInfo: { current: number; pageSize: number }) {
    pagination.value.current = pageInfo.current;
    pagination.value.pageSize = pageInfo.pageSize;
    try {
      loading.value = true;
      const { data } = await axios.post("/assets/batchGenerationData", {
        projectId: toLocalProjectId(project.value?.id),
        type,
        name: searchText.value || undefined,
        page: pageInfo.current,
        limit: pageInfo.pageSize,
      });
      tableData.value = data.data || [];
      localData.value = structuredClone(tableData.value);
      pagination.value.total = data.total || 0;
      return tableData.value;
    } catch (error) {
      console.error("加载资产数据失败:", error);
      tableData.value = [];
      pagination.value.total = 0;
    } finally {
      loading.value = false;
    }
  }

  function closeModal() {
    promptGenerateCancel.value = true;
    imageGenerateCancel.value = true;
    visible.value = false;
    selectedRowKeys.value = [];
    searchText.value = "";
  }

  async function processBatch<T>(list: T[], handler: (item: T) => Promise<void>) {
    const batchSize = otherSetting.value.assetsBatchGenereateSize || 5;
    for (let index = 0; index < list.length; index += batchSize) {
      await Promise.all(list.slice(index, index + batchSize).map(handler));
    }
  }

  async function onConfirm() {
    const selected = tableData.value.filter((item) => selectedRowKeys.value.includes(item.id));
    if (!selectedRowKeys.value.length) {
      window.$message.warning($t("workbench.assets.selectAtLeastOne"));
      return;
    }
    if (!selected.length) {
      window.$message.error($t("workbench.assets.batch.selectToSave"));
      return;
    }
    try {
      await processBatch(selected, async (item) => {
        await axios.post("/assets/updateAssets", {
          id: item.id,
          name: item.name,
          describe: item.describe ?? "",
          type: item.type,
          remark: item.remark ?? "",
          prompt: item.prompt,
        });
        if (item.filePath) {
          await axios.post("/assets/saveAssets", {
            id: item.id,
            base64: "",
            filePath: item.filePath,
            prompt: item.prompt,
            projectId: toLocalProjectId(project.value?.id),
          });
        }
      });
      window.$message.success($t("workbench.assets.batch.saveSuccess"));
      emitUpdate();
      closeModal();
    } catch (error) {
      console.error("保存失败:", error);
      window.$message.error($t("workbench.assets.batch.saveFail"));
    }
  }

  async function generatePrompt(item: AssetItem) {
    rowPromptLoading.value[item.id] = true;
    try {
      const { data } = await axios.post("/assets/polishAssetsPrompt", {
        projectId: toLocalProjectId(project.value?.id),
        assetsId: item.id,
        type: type ?? "props",
        name: item.name,
        describe: item.describe ?? "",
      });
      if (promptGenerateCancel.value) return;
      for (const list of [tableData.value, localData.value]) {
        const target = list.find((asset) => asset.id === data.assetsId);
        if (target) target.prompt = data.prompt;
      }
    } catch (error) {
      window.$message.error(`"${item.name}" ${(error as Error)?.message ?? $t("workbench.assets.batch.promptFail")}`);
    } finally {
      rowPromptLoading.value[item.id] = false;
    }
  }

  async function handleBatchGeneratePrompt() {
    const selected = tableData.value.filter((item) => selectedRowKeys.value.includes(item.id));
    if (!selected.length) {
      window.$message.error($t("workbench.assets.selectAtLeastOne"));
      return;
    }
    promptGenerateCancel.value = false;
    textLoading.value = true;
    try {
      await processBatch(selected, async (item) => {
        if (promptGenerateCancel.value) throw new Error($t("workbench.assets.batch.promptGenCancelled"));
        await generatePrompt(item);
      });
      window.$message.success($t("workbench.assets.batch.promptDone"));
    } catch (error) {
      if ((error as Error).message !== $t("workbench.assets.batch.promptGenCancelled")) {
        window.$message.error((error as Error).message);
      }
    } finally {
      textLoading.value = false;
      promptGenerateCancel.value = false;
    }
  }

  async function startGenerate(item: AssetItem) {
    if (imageGenerateCancel.value) return;
    rowImageLoading.value[item.id] = true;
    try {
      const { data } = await axios.post("/assets/generateAssets", {
        type: type ?? "props",
        projectId: toLocalProjectId(project.value?.id),
        name: item.name,
        base64: undefined,
        prompt: item.prompt ?? "",
        id: item.id,
      });
      if (imageGenerateCancel.value) return;
      for (const list of [tableData.value, localData.value]) {
        const target = list.find((asset) => asset.id === data.assetsId);
        if (target) target.filePath = data.path;
      }
    } catch (error) {
      if (!imageGenerateCancel.value) {
        window.$message.error(`"${item.name}" ${$t("workbench.assets.batch.imageGenFail")}: ${(error as Error)?.message ?? $t("workbench.assets.batch.unknownError")}`);
      }
    } finally {
      rowImageLoading.value[item.id] = false;
    }
  }

  async function handleBatchGenerateImage() {
    const selected = tableData.value.filter((item) => selectedRowKeys.value.includes(item.id));
    if (!selected.length) {
      window.$message.warning($t("workbench.assets.selectAtLeastOne"));
      return;
    }
    const missingPrompt = selected.filter((item) => !item.prompt?.trim());
    if (missingPrompt.length) {
      window.$message.warning($t("workbench.assets.batch.missingPrompts", { count: missingPrompt.length }));
      return;
    }
    imageGenerateCancel.value = false;
    imageLoading.value = true;
    try {
      await processBatch(selected, async (item) => {
        if (imageGenerateCancel.value) throw new Error($t("workbench.assets.batch.promptGenCancelled"));
        await startGenerate(item);
      });
      window.$message.success($t("workbench.assets.batch.imageDone"));
    } finally {
      imageLoading.value = false;
      imageGenerateCancel.value = false;
    }
  }

  watch(visible, (isVisible) => {
    if (isVisible) {
      localData.value = [];
      void handlePageChange({ current: 1, pageSize: pagination.value.pageSize });
    }
  });
  watch(searchText, () => {
    if (visible.value) void handlePageChange({ current: 1, pageSize: pagination.value.pageSize });
  });

  return {
    columns, tableData, rowPromptLoading, rowImageLoading, selectedRowKeys, searchText,
    loading, pagination, filteredData, textLoading, imageLoading, handleSelectChange,
    handleSelectAll, handleClearSelection, handlePageChange, closeModal, handleCancel: closeModal,
    onConfirm, handleBatchGeneratePrompt, handleBatchGenerateImage,
  };
}

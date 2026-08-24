import { ref } from "vue";
import { storeToRefs } from "pinia";
import { DialogPlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";
import { localProjectBody } from "@/features/tianjiang/project/local-project-id";
import settingStore from "@/stores/setting";
import type { AssetRecord } from "./assetsLogic";
import type { AssetsState } from "./useAssetsState";

export function useAssetsBatchActions(state: AssetsState) {
  const { otherSetting } = storeToRefs(settingStore());
  const batchGenerationShow = ref(false);
  const selectValue = ref("");
  const resolution = ref("1K");
  const batchType = ref("");

  function batchGeneration(type: number) {
    batchType.value =
      type === 1 ? $t("workbench.assets.batchGenPrompt") : $t("workbench.assets.batchGenImage");
    batchGenerationShow.value = true;
  }

  function getSelectedSubAssets(): AssetRecord[] {
    return state.tableData.value.flatMap((row) =>
      (row.sonAssets ?? []).filter((sub) => state.selectedSubRowKeys.value.includes(sub.id)),
    );
  }

  function selectedAssets() {
    const parents = state.tableData.value.filter((item) => state.selectedRowKeys.value.includes(item.id));
    return { parents, children: getSelectedSubAssets(), all: [...parents, ...getSelectedSubAssets()] };
  }

  function markAssets(assets: AssetRecord[], field: "state" | "promptState", value: string) {
    assets.forEach((asset) => {
      const target = state.findAssetById(asset.id);
      if (target) target[field] = value;
    });
  }

  async function handleBatchGeneratePrompt() {
    const { parents, children, all } = selectedAssets();
    if (!all.length) {
      window.$message.warning($t("workbench.assets.selectAtLeastOne"));
      return;
    }
    markAssets(all, "promptState", "生成中");
    state.selectedRowKeys.value = state.selectedRowKeys.value.filter(
      (key) => !parents.some((asset) => asset.id === key),
    );
    state.selectedSubRowKeys.value = state.selectedSubRowKeys.value.filter(
      (key) => !children.some((asset) => asset.id === key),
    );
    batchGenerationShow.value = false;
    try {
      // 资产页无额外润色文本时显式空串，不放宽服务端 otherTextPrompt 校验
      await axios.post(
        "/assetsGenerate/batchPolishAssetsPrompt",
        localProjectBody(state.project.value?.id, {
          concurrentCount: otherSetting.value.assetsBatchGenereateSize,
          otherTextPrompt: "",
          items: all.map((item) => ({
            assetsId: item.id,
            type: item.type ?? "props",
            name: item.name,
            describe: item.describe || $t("workbench.assets.noDescription"),
          })),
        }),
      );
    } catch (error) {
      window.$message.error((error as Error)?.message ?? $t("workbench.assets.promptGenFail"));
    }
  }

  async function handleBatchGenerateImage() {
    const { all } = selectedAssets();
    if (!all.length) {
      window.$message.warning($t("workbench.assets.selectAtLeastOne"));
      return;
    }
    if (!selectValue.value) {
      window.$message.error($t("workbench.assets.selectModel"));
      return;
    }
    if (!resolution.value) {
      window.$message.error($t("workbench.assets.selectResolution"));
      return;
    }
    const validAssets = all.filter((asset) => {
      if (asset.prompt) return true;
      window.$message.warning($t("workbench.assets.noPromptForImage", { name: asset.name }));
      return false;
    });
    if (!validAssets.length) return;
    markAssets(validAssets, "state", "生成中");
    state.selectedRowKeys.value = state.selectedRowKeys.value.filter(
      (key) => !validAssets.some((asset) => asset.id === key),
    );
    state.selectedSubRowKeys.value = state.selectedSubRowKeys.value.filter(
      (key) => !validAssets.some((asset) => asset.id === key),
    );
    batchGenerationShow.value = false;
    try {
      await axios.post(
        "/assetsGenerate/batchGenerateImageAssets",
        localProjectBody(state.project.value?.id, {
          model: selectValue.value,
          resolution: resolution.value,
          concurrentCount: otherSetting.value.assetsBatchGenereateSize,
          items: validAssets.map((item) => ({
            id: item.id,
            type: item.type ?? "props",
            name: item.name ?? $t("workbench.cornerScape.unnamed"),
            prompt: item.prompt || item.describe,
          })),
        }),
      );
    } catch (error) {
      window.$message.error(
        $t("workbench.assets.imageGenFail", { name: "", error: (error as Error)?.message ?? "" }),
      );
      markAssets(validAssets, "state", "生成失败");
    }
  }

  function keep() {
    if (batchType.value === $t("workbench.assets.batchGenPrompt")) {
      void handleBatchGeneratePrompt();
    } else if (batchType.value === $t("workbench.assets.batchGenImage")) {
      void handleBatchGenerateImage();
    }
  }

  function handleBatchDelete() {
    const { all } = selectedAssets();
    if (!all.length) {
      window.$message.warning($t("workbench.assets.selectAtLeastOne"));
      return;
    }
    const dialog = DialogPlugin.confirm({
      header: $t("workbench.assets.confirmDeleteHeader"),
      body: $t("workbench.assets.confirmBatchDeleteBody"),
      confirmBtn: $t("workbench.assets.deleteBtn"),
      cancelBtn: $t("workbench.assets.cancelBtn"),
      theme: "warning",
      onConfirm: async () => {
        await axios.post("/assets/batchDelete", { id: all.map((asset) => asset.id) });
        window.$message.success($t("workbench.assets.deleteSuccess"));
        void state.getFilteredData(state.assetOptions.value);
        dialog.destroy();
      },
    });
  }

  return {
    batchGenerationShow,
    selectValue,
    resolution,
    batchType,
    batchGeneration,
    keep,
    handleBatchGeneratePrompt,
    handleBatchGenerateImage,
    handleBatchDelete,
  };
}

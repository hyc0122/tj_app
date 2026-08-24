import { storeToRefs } from "pinia";
import axios from "@/utils/axios";
import { localProjectBody } from "@/features/tianjiang/project/local-project-id";
import settingStore from "@/stores/setting";
import type { CornerScapeDrawer } from "./useCornerScapeDrawer";
import type { CornerScapeState } from "./useCornerScapeState";

export function useCornerScapeBatchActions(state: CornerScapeState, drawer: CornerScapeDrawer) {
  const { otherSetting } = storeToRefs(settingStore());

  function selectedItems() {
    return state.dataList.value.filter((item) => state.selectedIds.value.includes(item.id));
  }

  async function batchGenerationPrompt() {
    const items = selectedItems();
    if (!items.length) {
      window.$message.warning($t("workbench.cornerScape.msg.selectAtLeastOne"));
      return;
    }
    items.forEach((item) => (item.promptState = "生成中"));
    state.selectedIds.value = [];
    try {
      await axios.post(
        "/assetsGenerate/batchPolishAssetsPrompt",
        localProjectBody(state.project.value?.id, {
          items: items.map((item) => ({
            assetsId: item.id,
            type: item.type ?? "props",
            name: item.name,
            describe: item.describe,
          })),
          concurrentCount: otherSetting.value.assetsBatchGenereateSize,
          otherTextPrompt: state.otherTextPrompt.value ?? "",
        }),
      );
    } catch (error) {
      window.$message.error((error as Error)?.message ?? $t("workbench.cornerScape.msg.promptGenFail"));
      items.forEach((item) => (item.promptState = ""));
    }
  }

  async function batchSelectBindAudio() {
    const items = selectedItems();
    if (!items.length) {
      window.$message.warning($t("workbench.cornerScape.msg.selectAtLeastBindOne"));
      return;
    }
    items.forEach((item) => (item.audioBindState = "生成中"));
    state.selectedIds.value = [];
    try {
      await axios.post(
        "/cornerScape/batchBindAudio",
        localProjectBody(state.project.value?.id, {
          assetsIds: items.map((item) => item.id),
          concurrentCount: otherSetting.value.assetsBatchGenereateSize,
        }),
      );
    } catch (error) {
      window.$message.error((error as Error)?.message ?? $t("workbench.cornerScape.msg.promptGenFail"));
      items.forEach((item) => (item.audioBindState = ""));
    }
  }

  async function batchGenerationImage() {
    const items = selectedItems();
    if (!items.length) {
      window.$message.warning($t("workbench.cornerScape.msg.selectAtLeastOne"));
      return;
    }
    if (!state.selectValue.value || !state.resolution.value) {
      window.$message.warning(
        $t(
          !state.selectValue.value
            ? "workbench.cornerScape.msg.selectModel"
            : "workbench.cornerScape.msg.selectResolution",
        ),
      );
      return;
    }
    const emptyPrompts = items.filter((item) => !item.prompt);
    if (emptyPrompts.length) {
      window.$message.warning(
        $t("workbench.cornerScape.msg.emptyPrompt", {
          emptyPromptNames: emptyPrompts.map((item) => item.name).join(", "),
        }),
      );
      return;
    }
    items.forEach((item) => drawer.setItemState(item.id, "生成中"));
    window.$message.success(
      $t("workbench.cornerScape.msg.batchStarted", {
        count: items.length,
        concurrent: otherSetting.value.assetsBatchGenereateSize,
      }),
    );
    try {
      await axios.post(
        "/assetsGenerate/batchGenerateImageAssets",
        localProjectBody(state.project.value?.id, {
          model: state.selectValue.value,
          resolution: state.resolution.value,
          concurrentCount: otherSetting.value.assetsBatchGenereateSize,
          items: items.map((item) => ({
            id: item.id,
            type: item.type ?? "props",
            name: item.name ?? $t("workbench.cornerScape.unnamed"),
            prompt: item.prompt,
          })),
        }),
      );
      state.selectedIds.value = [];
    } catch (error: any) {
      if (error.name === "CanceledError" || error.code === "ERR_CANCELED") return;
      window.$message.error(error.message ?? $t("workbench.cornerScape.msg.batchFailed"));
    }
  }

  return { batchGenerationPrompt, batchSelectBindAudio, batchGenerationImage };
}

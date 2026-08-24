import { computed, onUnmounted, watch } from "vue";
import axios from "@/utils/axios";
import { flattenAssets } from "./assetsLogic";
import type { AssetsState } from "./useAssetsState";

export function useAssetsPolling(state: AssetsState) {
  const pendingPrompts = computed(() =>
    flattenAssets(state.tableData.value).filter((item) => item.promptState === "生成中"),
  );
  const generatingImages = computed(() =>
    flattenAssets(state.tableData.value).filter((item) => item.state === "生成中"),
  );
  let promptTimer: ReturnType<typeof setInterval> | null = null;
  let imageTimer: ReturnType<typeof setInterval> | null = null;

  async function pollingPromptAssets() {
    if (!pendingPrompts.value.length) return;
    try {
      const { data } = await axios.post("/assets/pollingPromptAssets", {
        ids: pendingPrompts.value.map((item) => item.id),
      });
      if (Array.isArray(data) && data.length) {
        data.forEach((item: { id: number; promptState: string; prompt: string }) => {
          const target = state.findAssetById(item.id);
          if (!target) return;
          target.promptState = item.promptState;
          if (item.prompt !== undefined) target.prompt = item.prompt;
        });
        void state.getFilteredData(state.assetOptions.value);
      }
    } catch (error) {
      console.error("轮询提示词状态失败:", error);
    }
  }

  async function pollingImageAssets() {
    if (!generatingImages.value.length) return;
    try {
      const { data } = await axios.post("/assets/pollingImageAssets", {
        ids: generatingImages.value.map((item) => item.id),
      });
      if (Array.isArray(data) && data.length) {
        data.forEach((item: { id: number; state: string; filePath: string; src?: string }) => {
          const target = state.findAssetById(item.id);
          if (!target) return;
          target.state = item.state;
          if (item.filePath !== undefined) target.filePath = item.filePath;
          if (item.src !== undefined) target.src = item.src;
          if (!item.src && item.filePath && item.state !== "生成中") target.src = item.filePath;
        });
        void state.getFilteredData(state.assetOptions.value);
      }
    } catch (error) {
      console.error("轮询图片生成状态失败:", error);
    }
  }

  function startPromptPolling() {
    if (promptTimer) return;
    promptTimer = setInterval(() => {
      if (!pendingPrompts.value.length) stopPromptPolling();
      else void pollingPromptAssets();
    }, 3000);
  }

  function stopPromptPolling() {
    if (!promptTimer) return;
    clearInterval(promptTimer);
    promptTimer = null;
  }

  function startImagePolling() {
    if (imageTimer) return;
    imageTimer = setInterval(() => {
      if (!generatingImages.value.length) stopImagePolling();
      else void pollingImageAssets();
    }, 3000);
  }

  function stopImagePolling() {
    if (!imageTimer) return;
    clearInterval(imageTimer);
    imageTimer = null;
  }

  watch(pendingPrompts, (items) => (items.length ? startPromptPolling() : stopPromptPolling()));
  watch(generatingImages, (items) => (items.length ? startImagePolling() : stopImagePolling()));
  onUnmounted(() => {
    stopPromptPolling();
    stopImagePolling();
  });

  return {
    pendingPrompts,
    generatingImages,
    pollingPromptAssets,
    pollingImageAssets,
    startPromptPolling,
    stopPromptPolling,
    startImagePolling,
    stopImagePolling,
  };
}

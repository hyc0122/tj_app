import { computed, onUnmounted, watch } from "vue";
import axios from "@/utils/axios";
import { localProjectBody } from "@/features/tianjiang/project/local-project-id";
import type { CornerScapeItem } from "./cornerScapeTypes";
import type { CornerScapeDrawer } from "./useCornerScapeDrawer";
import type { CornerScapeState } from "./useCornerScapeState";

type PollingKind = "prompt" | "image" | "audio";

export function useCornerScapePolling(state: CornerScapeState, drawer: CornerScapeDrawer) {
  const pendingPrompts = computed(() => state.dataList.value.filter((item) => item.promptState === "生成中"));
  const generatingImages = computed(() => state.dataList.value.filter((item) => item.state === "生成中"));
  const bindingAudio = computed(() => state.dataList.value.filter((item) => item.audioBindState === "生成中"));
  const timers: Record<PollingKind, ReturnType<typeof setInterval> | null> = {
    prompt: null,
    image: null,
    audio: null,
  };

  async function refreshRelatedData(kind: PollingKind) {
    try {
      const { data } = await axios.post(
        "/cornerScape/getAllAssets",
        localProjectBody(state.project.value?.id, {
          type: state.checkboxValue.value,
        }),
      );
      (data as CornerScapeItem[]).forEach((fresh) => {
        const target = state.dataList.value.find((item) => item.id === fresh.id);
        if (!target) return;
        if (kind === "audio") target.relepedAudio = fresh.relepedAudio;
        else target.historyImages = fresh.historyImages;
      });
      if (drawer.currentItem.value) {
        const fresh = (data as CornerScapeItem[]).find(
          (item) => item.id === drawer.currentItem.value!.id,
        );
        if (fresh) {
          if (kind === "audio") drawer.currentItem.value.relepedAudio = fresh.relepedAudio;
          else drawer.currentItem.value.historyImages = fresh.historyImages;
        }
      }
    } catch (error) {
      console.error("刷新生成结果关联数据失败:", error);
    }
  }

  async function pollingPromptAssets() {
    if (!pendingPrompts.value.length) return;
    try {
      const { data } = await axios.post("/assets/pollingPromptAssets", {
        ids: pendingPrompts.value.map((item) => item.id),
      });
      let completed = false;
      if (Array.isArray(data)) {
        data.forEach((item: { id: number; promptState: string; prompt: string }) => {
          const target = state.dataList.value.find((row) => row.id === item.id);
          if (!target) return;
          if (target.promptState === "生成中" && item.promptState !== "生成中") completed = true;
          target.promptState = item.promptState;
          if (item.prompt !== undefined) target.prompt = item.prompt;
        });
      }
      if (completed) await refreshRelatedData("prompt");
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
      let completed = false;
      if (Array.isArray(data)) {
        data.forEach((item: { id: number; state: string; filePath: string }) => {
          const target = state.dataList.value.find((row) => row.id === item.id);
          if (!target) return;
          if (target.state === "生成中" && item.state !== "生成中") completed = true;
          target.state = item.state;
          if (item.filePath !== undefined) target.filePath = item.filePath;
        });
      }
      if (completed) await refreshRelatedData("image");
    } catch (error) {
      console.error("轮询图片生成状态失败:", error);
    }
  }

  async function pollingAudioBind() {
    if (!bindingAudio.value.length) return;
    try {
      const { data } = await axios.post("/cornerScape/pollingAudio", {
        ids: bindingAudio.value.map((item) => item.id),
      });
      let completed = false;
      if (Array.isArray(data)) {
        data.forEach((item: { id: number; audioBindState: string; filePath: string }) => {
          const target = state.dataList.value.find((row) => row.id === item.id);
          if (!target) return;
          if (target.audioBindState === "生成中" && item.audioBindState !== "生成中") completed = true;
          target.audioBindState = item.audioBindState;
          if (item.filePath !== undefined) target.filePath = item.filePath;
        });
      }
      if (completed) await refreshRelatedData("audio");
    } catch (error) {
      console.error("轮询音频绑定状态失败:", error);
    }
  }

  const pollers = {
    prompt: { items: pendingPrompts, run: pollingPromptAssets },
    image: { items: generatingImages, run: pollingImageAssets },
    audio: { items: bindingAudio, run: pollingAudioBind },
  };

  function stop(kind: PollingKind) {
    if (!timers[kind]) return;
    clearInterval(timers[kind]!);
    timers[kind] = null;
  }
  function start(kind: PollingKind) {
    if (timers[kind]) return;
    timers[kind] = setInterval(() => {
      if (!pollers[kind].items.value.length) stop(kind);
      else void pollers[kind].run();
    }, 3000);
  }

  watch(pendingPrompts, (items) => (items.length ? start("prompt") : stop("prompt")));
  watch(generatingImages, (items) => (items.length ? start("image") : stop("image")));
  watch(bindingAudio, (items) => (items.length ? start("audio") : stop("audio")));
  onUnmounted(() => {
    stop("prompt");
    stop("image");
    stop("audio");
  });

  return {
    notCompultedData: pendingPrompts,
    generatingData: generatingImages,
    audioBindData: bindingAudio,
    pollingPromptAssets,
    pollingImageAssets,
    pollingAudioBind,
    startPolling: () => start("prompt"),
    stopPolling: () => stop("prompt"),
    startImagePolling: () => start("image"),
    stopImagePolling: () => stop("image"),
    startAudioPolling: () => start("audio"),
    stopAudioPolling: () => stop("audio"),
  };
}

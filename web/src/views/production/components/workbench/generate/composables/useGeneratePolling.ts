import { computed, onUnmounted, watch, type Ref } from "vue";
import axios from "@/utils/axios";
import { localProjectBody, toPositiveSafeInteger } from "@/features/tianjiang/project/local-project-id";
import type { GenerateState } from "./useGenerateState";

type GenerationState = "生成中" | "未生成" | "已完成" | "生成失败";

interface VideoStateResponse {
  id: number;
  state: GenerationState;
  src?: string;
  errorReason?: string;
}

interface PromptStateResponse {
  id: number;
  state: GenerationState;
  prompt?: string;
  reason?: string;
}

export function useGeneratePolling(state: GenerateState, episodesId: Ref<number>) {
  let videoTimer: ReturnType<typeof setInterval> | null = null;
  let promptTimer: ReturnType<typeof setInterval> | null = null;

  const generatingVideoIds = computed(() =>
    state.trackList.value.flatMap((track) =>
      track.videoList.filter((video) => video.state === "生成中").map((video) => video.id),
    ),
  );
  const generatingPromptIds = computed(() =>
    state.trackList.value.filter((track) => track.state === "生成中").map((track) => track.id),
  );

  async function getVideoList() {
    const { data } = await axios.post(
      "/production/workbench/checkVideoStateList",
      localProjectBody(state.project.value?.id, {
        scriptId: toPositiveSafeInteger(episodesId.value),
        videoIds: generatingVideoIds.value,
      }),
    );
    if (!Array.isArray(data)) return;
    data.forEach((item: VideoStateResponse) => {
      for (const track of state.trackList.value) {
        const video = track.videoList.find((candidate) => candidate.id === item.id);
        if (!video) continue;
        video.state = item.state;
        video.src = item.src ?? "";
        video.errorReason = item.errorReason ?? "";
        break;
      }
    });
  }

  async function getTrackPromptList() {
    const { data } = await axios.post(
      "/production/workbench/checkVideoPrompt",
      localProjectBody(state.project.value?.id, {
        scriptId: toPositiveSafeInteger(episodesId.value),
        trackIds: generatingPromptIds.value,
      }),
    );
    if (!Array.isArray(data)) return;
    data.forEach((item: PromptStateResponse) => {
      const track = state.trackList.value.find((candidate) => candidate.id === item.id);
      if (!track) return;
      track.state = item.state;
      track.prompt = item.prompt ?? "";
      track.reason = item.reason ?? "";
      if (item.state === "生成失败") {
        window.$message.error(`提示词生成失败，${item.reason ?? "未知原因"}`);
      }
    });
  }

  function startVideoPolling() {
    if (videoTimer !== null) return;
    videoTimer = setInterval(() => void getVideoList(), 3000);
  }

  function stopVideoPolling() {
    if (videoTimer === null) return;
    clearInterval(videoTimer);
    videoTimer = null;
  }

  function startPromptPolling() {
    if (promptTimer !== null) return;
    promptTimer = setInterval(() => void getTrackPromptList(), 3000);
  }

  function stopPromptPolling() {
    if (promptTimer === null) return;
    clearInterval(promptTimer);
    promptTimer = null;
  }

  watch(generatingVideoIds, (ids) => {
    if (ids.length > 0) startVideoPolling();
    else stopVideoPolling();
  });
  watch(generatingPromptIds, (ids) => {
    if (ids.length > 0) startPromptPolling();
    else stopPromptPolling();
  });
  onUnmounted(() => {
    stopVideoPolling();
    stopPromptPolling();
  });

  return {
    generatingVideoIds,
    generatingPromptIds,
    startVideoPolling,
    stopVideoPolling,
    startPromptPolling,
    stopPromptPolling,
    getVideoList,
    getTrackPromptList,
  };
}

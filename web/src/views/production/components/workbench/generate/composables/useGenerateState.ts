import { computed, ref, watch, type Ref } from "vue";
import { storeToRefs } from "pinia";
import { DialogPlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";
import { localProjectBody, toLocalProjectId, toPositiveSafeInteger } from "@/features/tianjiang/project/local-project-id";
import projectStore from "@/stores/project";
import imageListCacheStore from "@/stores/imageListCache";
import {
  buildReferencePreviews,
  clampTrackDuration,
  formatVideoModeOptions,
  parseVideoMode,
  parseVideoModelDetail,
  sortReferenceMedia,
} from "./generateLogic";

export interface GenerateProject {
  id: string;
  videoModel: string;
  mode: string;
}

export function useGenerateState(episodesId: Ref<number>) {
  const { project: projectStoreRef } = storeToRefs(projectStore());
  const project = projectStoreRef as Ref<GenerateProject | null>;
  const activeTrackIndex = ref(0);
  const cacheStore = imageListCacheStore();
  const { getCache, setCache, initCacheFromTrackList, warmUpUrls } = cacheStore;
  const { urlMap } = storeToRefs(cacheStore);

  const modeOptions = ref<VideoModel>({
    name: "",
    modelName: "",
    durationResolutionMap: [],
    audio: false,
    type: "video",
    mode: [],
  });
  const trackList = ref<TrackItem[]>([]);
  const modelParmas = ref<ModelSetting>({
    mode: "",
    model: "",
    resolution: "480p",
    duration: 8,
    audio: false,
  });
  const modelStatus = ref("");
  let modelDetailGeneration = 0;
  const emptyModeOptions = (): VideoModel => ({
    name: "",
    modelName: "",
    durationResolutionMap: [],
    audio: false,
    type: "video",
    mode: [],
  });
  const storyboardList = ref<StoryboardItem[]>([]);

  const currentTrack = computed<TrackItem>({
    get: () => trackList.value[activeTrackIndex.value]!,
    set: (value) => {
      trackList.value[activeTrackIndex.value] = value;
    },
  });

  const imageList = computed<UploadItem[]>({
    get() {
      // URL 预热完成后重新读取缓存，确保界面拿到完整可访问地址。
      urlMap.value;
      const trackId = currentTrack.value?.id;
      const projectId = project.value?.id;
      const scriptId = episodesId.value;
      if (projectId != null && scriptId != null && trackId != null) {
        const cached = getCache(projectId, scriptId, trackId);
        if (cached?.length) return sortReferenceMedia(cached as UploadItem[]);
      }
      const medias = currentTrack.value?.medias;
      return medias?.length ? sortReferenceMedia(medias as UploadItem[]) : [];
    },
    set(value) {
      if (!currentTrack.value) return;
      currentTrack.value.medias = value as TrackMedia[];
      const projectId = project.value?.id;
      const scriptId = episodesId.value;
      if (projectId != null && scriptId != null && currentTrack.value.id != null) {
        setCache(projectId, scriptId, currentTrack.value.id, value);
      }
    },
  });

  function modeChange(newMode: string) {
    if (newMode === modelParmas.value.mode) return;
    if ((imageList.value.length || currentTrack.value?.prompt) && modelParmas.value.mode) {
      const dialog = DialogPlugin.confirm({
        header: $t("workbench.generate.modeChange"),
        body: $t("workbench.generate.modeChangeConfirm"),
        confirmBtn: $t("settings.generate.modelChnageSure"),
        cancelBtn: $t("settings.memory.msg.cancel"),
        onConfirm: async () => {
          imageList.value = [];
          currentTrack.value.prompt = "";
          dialog.destroy();
          modelParmas.value.mode = newMode;
        },
      });
      return;
    }
    if (newMode) modelParmas.value.mode = newMode;
  }

  const modeList = computed(() => formatVideoModeOptions(modeOptions.value.mode as Array<string | string[]>));

  function clampDuration(duration: number): number {
    return clampTrackDuration(duration, modeOptions.value.durationResolutionMap?.[0]?.duration);
  }

  function safeModelStatus(payload: { code?: unknown; message?: unknown } | null): string {
    const code = String(payload?.code ?? "");
    if (code === "DREAMINA_CLI_DISABLED") return "即梦 CLI 已关闭";
    if (code === "DREAMINA_CLI_NOT_INSTALLED") return "未安装即梦 CLI 或无法执行";
    if (code === "DREAMINA_CLI_NOT_LOGGED_IN") return "未登录即梦账号";
    if (code === "DREAMINA_CLI_MODEL_UNSUPPORTED") return "当前即梦模型不支持";
    if (code === "STORYBOARD_DREAMINA_CLI_UNAVAILABLE") return "即梦 CLI 不可用";
    const message = typeof payload?.message === "string" ? payload.message.trim() : "";
    if (
      message
      && /[\u4e00-\u9fff]/.test(message)
      && !/[A-Za-z]:\\|SELECT |cookie|sk-/i.test(message)
      && message.length <= 40
    ) {
      return message;
    }
    if (code.includes("DREAMINA") || code.includes("UNAVAILABLE")) return "即梦 CLI 不可用";
    return "视频模型暂不可用";
  }

  watch(
    () => modelParmas.value.model,
    async (modelId) => {
      const generation = ++modelDetailGeneration;
      if (!modelId) {
        modeOptions.value = emptyModeOptions();
        modelParmas.value.mode = "";
        modelParmas.value.audio = false;
        modelStatus.value = "";
        return;
      }
      modelStatus.value = "";
      try {
        const { data } = await axios.post("/modelSelect/getModelDetail", { modelId });
        // 中文注释：只接受仍对应当前选择的详情；旧请求不得覆盖新模型。
        if (generation !== modelDetailGeneration) return;
        const parsed = parseVideoModelDetail(data);
        if (!parsed.ok) {
          modeOptions.value = emptyModeOptions();
          modelParmas.value.audio = false;
          const coded = safeModelStatus(data as { code?: unknown; message?: unknown });
          modelStatus.value = coded === "视频模型暂不可用" ? parsed.reason : coded;
          return;
        }
        modeOptions.value = parsed.detail as VideoModel;
        // 中文注释：只有明确 true/optional 才打开音频；缺失已在解析阶段拒绝。
        modelParmas.value.audio = parsed.detail.audio === true || parsed.detail.audio === "optional";
        const durationMap = parsed.detail.durationResolutionMap;
        if (Array.isArray(durationMap) && durationMap.length > 0) {
          if (durationMap[0].resolution?.length) modelParmas.value.resolution = durationMap[0].resolution[0];
          if (durationMap[0].duration?.length) modelParmas.value.duration = clampDuration(modelParmas.value.duration);
        }
        const parsedMode = parseVideoMode(modelParmas.value.mode);
        const modeMatched =
          parsedMode !== null &&
          parsed.detail.mode.some((mode) =>
            Array.isArray(mode) && Array.isArray(parsedMode)
              ? JSON.stringify(mode) === JSON.stringify(parsedMode)
              : mode === parsedMode,
          );
        if (!modeMatched && parsed.detail.mode[0] != null) {
          modeChange(Array.isArray(parsed.detail.mode[0]) ? JSON.stringify(parsed.detail.mode[0]) : parsed.detail.mode[0]);
        }
      } catch (error) {
        if (generation !== modelDetailGeneration) return;
        modeOptions.value = emptyModeOptions();
        modelParmas.value.audio = false;
        modelStatus.value = safeModelStatus(error as { code?: unknown; message?: unknown });
        if (modelStatus.value === "视频模型暂不可用" && modelId.startsWith("dreamina-cli:")) {
          modelStatus.value = "即梦 CLI 不可用";
        }
      }
    },
  );

  const references = computed(() => buildReferencePreviews(imageList.value));

  async function getGenerateData() {
    const { data } = await axios.post(
      "/production/workbench/getGenerateData",
      localProjectBody(project.value?.id, {
        scriptId: toPositiveSafeInteger(episodesId.value),
      }),
    );
    storyboardList.value = data.storyboardList;
    const projectId = project.value?.id;
    const scriptId = episodesId.value;
    if (projectId != null && scriptId != null) {
      initCacheFromTrackList(projectId, scriptId, data.trackList);
      await warmUpUrls(projectId, scriptId);
      data.trackList.forEach((track: TrackItem) => {
        if (track.id == null) return;
        const cached = getCache(projectId, scriptId, track.id);
        if (cached?.length) track.medias = cached as TrackMedia[];
      });
      trackList.value = [...data.trackList];
    }
    modelParmas.value.duration = clampDuration(data.trackList?.[activeTrackIndex.value]?.duration);
  }

  function handlePromptBlur() {
    const trackId = trackList.value[activeTrackIndex.value]?.id;
    if (trackId == null) return;
    void axios.post("/production/workbench/updateVideoPrompt", {
      id: trackId,
      prompt: currentTrack.value?.prompt,
    });
  }

  function trackChange(previousIndex?: number) {
    const projectId = project.value?.id;
    const scriptId = episodesId.value;
    if (previousIndex != null) {
      const previousTrack = trackList.value[previousIndex];
      if (projectId != null && scriptId != null && previousTrack?.id != null) {
        setCache(projectId, scriptId, previousTrack.id, previousTrack.medias as UploadItem[]);
      }
    }
    const nextTrack = trackList.value[activeTrackIndex.value];
    if (projectId != null && scriptId != null && nextTrack?.id != null) {
      const cached = getCache(projectId, scriptId, nextTrack.id);
      if (cached) nextTrack.medias = cached as TrackMedia[];
    }
    if (modelParmas.value.mode === "singleImage" && imageList.value.length > 1) {
      imageList.value = imageList.value.slice(0, 1);
    }
    modelParmas.value.duration = clampDuration(nextTrack?.duration);
  }

  watch(
    () => currentTrack.value?.medias,
    (medias) => {
      const projectId = project.value?.id;
      const scriptId = episodesId.value;
      const trackId = currentTrack.value?.id;
      if (medias && projectId != null && scriptId != null && trackId != null) {
        setCache(projectId, scriptId, trackId, medias as UploadItem[]);
      }
    },
    { deep: true },
  );

  return {
    project,
    activeTrackIndex,
    modeOptions,
    trackList,
    modelParmas,
    modelStatus,
    storyboardList,
    currentTrack,
    imageList,
    modeList,
    references,
    modeChange,
    clampDuration,
    getGenerateData,
    handlePromptBlur,
    trackChange,
  };
}

export type GenerateState = ReturnType<typeof useGenerateState>;

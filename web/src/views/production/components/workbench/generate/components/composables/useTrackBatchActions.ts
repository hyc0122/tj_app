import { inject, ref, type Ref } from "vue";
import { storeToRefs } from "pinia";
import { DialogPlugin } from "tdesign-vue-next";
import JSZip from "jszip";
import axios from "@/utils/axios";
import { localProjectBody, toLocalProjectId, toPositiveSafeInteger } from "@/features/tianjiang/project/local-project-id";
import projectStore from "@/stores/project";
import settingStore from "@/stores/setting";
import {
  createPendingOperationIdentity,
  fingerprintWorkbenchRequestIntent,
  safeWorkbenchVideoError,
} from "../../composables/workbenchRequestIdentity";
import type { TrackComponentProps, TrackEmit } from "./useTrackSelection";

export function useTrackBatchActions(
  props: TrackComponentProps,
  activeTrackIndex: Ref<number>,
  trackList: Ref<TrackItem[]>,
  checkedTrackIds: Ref<number[]>,
  checkAll: Ref<boolean>,
  emit: TrackEmit,
) {
  const pendingVideoOperations = createPendingOperationIdentity();
  const { otherSetting } = storeToRefs(settingStore());
  const { project } = storeToRefs(projectStore());
  const episodesId = inject<Ref<number>>("episodesId")!;
  const generateTextLoad = ref(false);
  const generateVideoLoad = ref(false);

  async function addTrack() {
    if (!String(props.modelParmas.model || "").trim()) {
      window.$message.error("请先选择模型");
      return;
    }
    const { data: modelData } = await axios.post("/modelSelect/getModelDetail", {
      modelId: props.modelParmas.model,
    });
    const durationMap = modelData.durationResolutionMap;
    if (!Array.isArray(durationMap) || !durationMap[0]?.duration?.length) {
      window.$message.error("视频模型详情未就绪");
      return;
    }
    await axios.post(
      "/production/workbench/addTrack",
      localProjectBody(project.value?.id, {
        scriptId: toPositiveSafeInteger(episodesId.value),
        duration: durationMap[0].duration[0],
      }),
    );
    emit("getData");
    activeTrackIndex.value = trackList.value.length - 1;
  }

  function getFileExtension(url: string): string {
    return url.split(".").pop()?.split(/[#?]/)[0] || "mp4";
  }

  async function batchDownloadVideo() {
    const zip = new JSZip();
    const tasks = trackList.value
      .filter((track) => checkedTrackIds.value.includes(track.id))
      .map((track) => {
        const video = track.videoList.find((item) => item.id === track.selectVideoId);
        if (!video?.src) return null;
        return fetch(video.src)
          .then((response) => response.blob())
          .then((blob) => zip.file(`分镜${track.id}.${getFileExtension(video.src)}`, blob))
          .catch((error) => console.error(`视频下载失败: ${video.src}`, error));
      })
      .filter(Boolean);
    await Promise.all(tasks);
    const url = URL.createObjectURL(await zip.generateAsync({ type: "blob" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `视频批量下载_${Date.now()}.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    checkedTrackIds.value = [];
    checkAll.value = false;
  }

  function getTrackUploadInfo(track: TrackItem, filterEmpty = false) {
    const activeTrackId = trackList.value[activeTrackIndex.value]?.id;
    const media = track.id === activeTrackId ? props.imageList : track.medias;
    return media
      .filter((item) => !filterEmpty || Boolean(item.src))
      .map(({ id, sources }) => ({ id, sources: (sources ?? "storyboard") as string }));
  }

  function batchGenText() {
    generateTextLoad.value = true;
    const trackData: Array<{ trackId: number; info: Array<{ id?: number | null; sources: string }> }> = [];
    trackList.value.forEach((track) => {
      if (!checkedTrackIds.value.includes(track.id)) return;
      const info =
        props.modelParmas.mode === "text"
          ? track.medias.map(({ id, sources }) => ({ id, sources: sources ?? "storyboard" }))
          : getTrackUploadInfo(track);
      trackData.push({
        trackId: track.id,
        info: info.filter((item) => typeof item.id === "number" && !Number.isNaN(item.id)),
      });
      track.state = "生成中";
    });
    axios
      .post("/production/workbench/batchGeneratePrompt", {
        projectId: toLocalProjectId(project.value?.id),
        trackData,
        model: props.modelParmas.model,
        mode: props.modelParmas.mode,
        concurrentCount: otherSetting.value.assetsBatchGenereateSize,
      })
      .then(() => {
        window.$message.success("开始生成提示词");
        generateTextLoad.value = false;
        checkedTrackIds.value = [];
        checkAll.value = false;
      })
      .catch((error) => {
        window.$message.error(error?.message ?? "生成提示词失败");
        trackList.value.forEach((track) => (track.state = "生成失败"));
      });
  }

  function batchGenVideo() {
    const selectedTracks = trackList.value.filter((track) => checkedTrackIds.value.includes(track.id));
    if (selectedTracks.length === 0) {
      window.$message.error("请先选择轨道");
      return;
    }
    if (!String(props.modelParmas.model || "").trim()) {
      window.$message.error("请先选择模型");
      return;
    }
    const buildRequestIntent = (intentTracks: TrackItem[]) => localProjectBody(project.value?.id, {
      // 中文注释：批量请求意图包含轨道顺序、逐轨提示词/素材与全部生成参数，确认期间不得混用新旧状态。
      scriptId: toPositiveSafeInteger(episodesId.value),
      model: props.modelParmas.model,
      mode: props.modelParmas.mode,
      resolution: props.modelParmas.resolution,
      audio: Boolean(props.modelParmas.audio),
      trackData: intentTracks.map((track) => ({
        duration: props.clampDuration(track.duration || props.modelParmas.duration),
        prompt: track.prompt,
        uploadData: props.modelParmas.mode === "text" ? [] : getTrackUploadInfo(track, true),
        trackId: track.id,
      })),
      paidBatchConfirmed: true,
    });
    let confirmedIntent: ReturnType<typeof buildRequestIntent>;
    try {
      // 中文注释：打开确认框时冻结完整批量请求，响应确认时只允许提交这份一致快照。
      confirmedIntent = buildRequestIntent(selectedTracks);
    } catch (error) {
      window.$message.error(safeWorkbenchVideoError(error, "视频批量发起生成请求失败"));
      return;
    }
    const confirmedFingerprint = fingerprintWorkbenchRequestIntent(confirmedIntent);
    let dialog: { destroy: () => void } | undefined;
    dialog = DialogPlugin.confirm({
      header: $t("workbench.generate.generateConfirm"),
      body: $t("workbench.generate.generateVideosInBatches"),
      onConfirm: async () => {
        dialog?.destroy();
        const currentSelectedTracks = trackList.value.filter((track) => checkedTrackIds.value.includes(track.id));
        let currentIntent: ReturnType<typeof buildRequestIntent> | null = null;
        try {
          currentIntent = buildRequestIntent(currentSelectedTracks);
        } catch {
          // 中文注释：确认期间项目或剧本身份失效同样视为配置变化，必须保持零请求。
        }
        if (!currentIntent || fingerprintWorkbenchRequestIntent(currentIntent) !== confirmedFingerprint) {
          window.$message.error("生成配置已变化，请重新确认");
          return;
        }
        if (currentSelectedTracks.some((track) => !track.prompt)) {
          return window.$message.warning($t("workbench.generate.skipDataWithEmptyVideoPromptWords"));
        }
        try {
          const reservation = pendingVideoOperations.reserve(confirmedIntent);
          const { data } = await axios.post(
            "/production/workbench/batchGenerateVideo",
            { ...confirmedIntent, clientOperationId: reservation.clientOperationId },
          );
          pendingVideoOperations.complete(reservation);
          const videoIds = Object.fromEntries(
            data.map((item: { videoId: number; trackId: number }) => [item.trackId, item.videoId]),
          );
          currentSelectedTracks.forEach((track) => {
            const videoId = videoIds[track.id];
            // 中文注释：同一批次并发重放按服务端 videoId 合并，禁止重复展示和轮询。
            if (videoId && !track.videoList.some((item) => item.id === videoId)) {
              track.videoList.push({ id: videoId, state: "生成中", src: "" });
            }
          });
          checkedTrackIds.value = [];
          window.$message.success($t("workbench.generate.generateStarted"));
        } catch (error) {
          window.$message.error(safeWorkbenchVideoError(error, "视频批量发起生成请求失败"));
        } finally {
          generateVideoLoad.value = false;
        }
      },
      onCancel: () => dialog?.destroy(),
    });
  }

  return {
    generateTextLoad,
    generateVideoLoad,
    addTrack,
    batchDownloadVideo,
    batchGenText,
    batchGenVideo,
  };
}

import { inject, ref, watch, type Ref } from "vue";
import { storeToRefs } from "pinia";
import { DialogPlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import imageListCacheStore from "@/stores/imageListCache";

export interface TrackComponentProps {
  modelParmas: ModelSetting;
  imageList: UploadItem[];
  clampDuration: (trackDuration: number) => number;
}

export interface TrackEmit {
  (event: "getData"): void;
  (event: "change", previousIndex: number): void;
  (event: "saveImageList", trackId: number): void;
}

export function useTrackSelection(
  activeTrackIndex: Ref<number>,
  trackList: Ref<TrackItem[]>,
  emit: TrackEmit,
) {
  const { project } = storeToRefs(projectStore());
  const { removeCache } = imageListCacheStore();
  const episodesId = inject<Ref<number>>("episodesId")!;
  const checkedTrackIds = ref<number[]>([]);
  const checkAll = ref(false);
  const videoCoverMap = ref<Record<string, string>>({});

  function getSelectedVideoSrc(track: TrackItem): string | null {
    if (!track.selectVideoId) return null;
    return track.videoList?.find((video) => video.id === track.selectVideoId)?.src || null;
  }

  function captureVideoCover(src: string) {
    if (!src || videoCoverMap.value[src]) return;
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.muted = true;
    video.src = src;
    video.addEventListener(
      "seeked",
      () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth || 160;
          canvas.height = video.videoHeight || 90;
          const context = canvas.getContext("2d");
          if (context) {
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            videoCoverMap.value[src] = canvas.toDataURL("image/jpeg", 0.7);
          }
        } catch {
          // 跨域视频无法绘制时继续使用占位图，不影响轨道操作。
        }
        video.src = "";
      },
      { once: true },
    );
    video.addEventListener("loadeddata", () => (video.currentTime = 0), { once: true });
    video.addEventListener("error", () => (video.src = ""), { once: true });
    video.load();
  }

  function changeIndex(index: number) {
    if (activeTrackIndex.value === index) return;
    const previousIndex = activeTrackIndex.value;
    activeTrackIndex.value = index;
    emit("change", previousIndex);
  }

  async function deleteTrack(index: number) {
    const track = trackList.value[index];
    if (!track) return;
    await axios.post("/production/workbench/deleteTrack", { id: track.id });
    checkedTrackIds.value = checkedTrackIds.value.filter((id) => id !== track.id);
    const projectId = project.value?.id;
    const scriptId = episodesId.value;
    if (projectId != null && scriptId != null && track.id != null) {
      removeCache(projectId, scriptId, track.id);
    }
    if (activeTrackIndex.value >= trackList.value.length) {
      activeTrackIndex.value = trackList.value.length - 1;
    }
  }

  function confirmDeleteTrack(index: number) {
    const dialog = DialogPlugin.confirm({
      header: $t("workbench.generate.del"),
      body: $t("workbench.generate.delConfirm"),
      confirmBtn: $t("settings.generate.delConfirmBtn"),
      cancelBtn: $t("settings.memory.msg.cancel"),
      onConfirm: async () => {
        try {
          await deleteTrack(index);
          window.$message.success($t("workbench.generate.delSuccess"));
          emit("getData");
        } catch (error) {
          window.$message.error((error as Error).message ?? `${$t("workbench.cornerScape.cancelGeneration")}失败`);
        } finally {
          dialog.destroy();
        }
      },
    });
  }

  function handleCheckAll(checked: boolean) {
    const allIds = trackList.value.map((track) => track.id).filter((id): id is number => id != null);
    checkedTrackIds.value = checked ? allIds : [];
  }

  function toggleCheck(trackId: number | undefined, checked: boolean) {
    if (trackId == null) return;
    if (checked && !checkedTrackIds.value.includes(trackId)) checkedTrackIds.value.push(trackId);
    if (!checked) checkedTrackIds.value = checkedTrackIds.value.filter((id) => id !== trackId);
    const allIds = trackList.value.map((track) => track.id).filter((id): id is number => id != null);
    checkAll.value = allIds.length > 0 && allIds.every((id) => checkedTrackIds.value.includes(id));
  }

  watch(
    () => trackList.value.map((track) => ({ selectVideoId: track.selectVideoId, videoList: track.videoList })),
    () => {
      trackList.value.forEach((track) => {
        const source = getSelectedVideoSrc(track);
        if (source) captureVideoCover(source);
      });
    },
    { deep: true, immediate: true },
  );

  return {
    checkedTrackIds,
    checkAll,
    videoCoverMap,
    getSelectedVideoSrc,
    changeIndex,
    confirmDeleteTrack,
    handleCheckAll,
    toggleCheck,
  };
}

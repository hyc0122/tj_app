import { computed, onMounted, onUnmounted, reactive, ref, type Ref } from "vue";
import {
  useTracksStore,
  usePlaybackStore,
  useHistoryStore,
  type Track,
} from "vue-clip-track";
import type { MediaItem, AudioItem } from "../utils/mediaData";
import { loadInitialAudioWaveforms } from "../utils/mediaLoader";
import videoPreview from "../videoPreview.vue";
import {
  clipConfigs,
  createEditVideoPropBindings,
  operationButtons,
  scaleConfigButtons,
  trackTypes,
} from "./editVideoConfig";
import { useEditVideoMediaDrop } from "./useEditVideoMediaDrop";

export interface EditVideoProps {
  initialTracks: Track[];
  initialVideoItems?: MediaItem[];
  initialMediaItems: MediaItem[];
  initialAudioItems: AudioItem[];
  initialImageItems: MediaItem[];
  canvasWidth: number;
  canvasHeight: number;
}

export function useEditVideoPage(props: EditVideoProps) {
  const tracksStore = useTracksStore();
  const playbackStore = usePlaybackStore();
  const historyStore = useHistoryStore();
  const previewWrapperRef = ref<HTMLElement>();
  const videoTrackRef = ref();
  const videoPreviewRef = ref<InstanceType<typeof videoPreview>>();
  const isExporting = ref(false);
  const wrapperSize = reactive({ width: 0, height: 0 });
  let resizeObserver: ResizeObserver | null = null;

  const previewStyle = computed(() => {
    const { width, height } = wrapperSize;
    if (width <= 0 || height <= 0) return {};
    const ratio = props.canvasWidth / props.canvasHeight;
    if (width / height > ratio) {
      return { height: `${height}px`, width: `${Math.floor(height * ratio)}px` };
    }
    return { width: `${width}px`, height: `${Math.floor(width / ratio)}px` };
  });

  async function handleExport() {
    if (!videoPreviewRef.value || isExporting.value) return;
    isExporting.value = true;
    try {
      await videoPreviewRef.value.exportVideo();
      window.$message.success($t("workbench.production.editVideo.exportSuccess"));
    } catch (error: any) {
      if (error.name === "AbortError") return;
      window.$message.error(error.message || $t("workbench.production.editVideo.exportFailed"));
    } finally {
      isExporting.value = false;
    }
  }

  function handleSplit() {
    const selectedIds = Array.from(tracksStore.selectedClipIds);
    if (selectedIds.length === 0) return;
    const currentTime = playbackStore.currentTime;
    selectedIds.forEach((id) => {
      const clip = tracksStore.getClip(id);
      if (clip && currentTime > clip.startTime && currentTime < clip.endTime) {
        tracksStore.splitClip(id, currentTime);
      }
    });
    historyStore.pushSnapshot($t("workbench.production.editVideo.splitClip"));
  }

  function handleDeleteClips() {
    const selectedIds = Array.from(tracksStore.selectedClipIds);
    if (selectedIds.length === 0) return;
    tracksStore.removeClips(selectedIds);
    historyStore.pushSnapshot($t("workbench.production.editVideo.deleteClip"));
  }

  const mediaDrop = useEditVideoMediaDrop({ tracksStore, historyStore, playbackStore, videoTrackRef });

  function initializeTracks() {
    tracksStore.reset();
    props.initialTracks.forEach((track) => tracksStore.addTrack(track));
    playbackStore.setDuration(60 * 5);
    playbackStore.seekTo(0);
    historyStore.initialize();
    loadInitialAudioWaveforms(tracksStore);
  }

  onMounted(() => {
    initializeTracks();
    if (!previewWrapperRef.value) return;
    resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        wrapperSize.width = entry.contentRect.width;
        wrapperSize.height = entry.contentRect.height;
      }
    });
    resizeObserver.observe(previewWrapperRef.value);
  });

  onUnmounted(() => {
    playbackStore.pause();
    resizeObserver?.disconnect();
  });

  return {
    ...createEditVideoPropBindings(props),
    tracksStore,
    historyStore,
    previewWrapperRef,
    videoTrackRef,
    videoPreviewRef,
    previewStyle,
    isExporting,
    operationButtons: ref(operationButtons),
    scaleConfigButtons: ref(scaleConfigButtons),
    trackTypes: ref(trackTypes),
    clipConfigs: ref(clipConfigs),
    handleExport,
    handleSplit,
    handleDeleteClips,
    ...mediaDrop,
  };
}

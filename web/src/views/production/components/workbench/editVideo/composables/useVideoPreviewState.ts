import { computed, provide, reactive, ref, shallowRef } from "vue";
import { usePlaybackStore, useTracksStore } from "vue-clip-track";
import type { VisibleSprite } from "@webav/av-cliper";
import type { AVCanvas } from "@webav/av-canvas";
import type {
  AVCanvasDebugData,
  TransitionInfo,
  VideoPreviewContext,
  VideoPreviewProps,
} from "./videoPreviewTypes";
import { microsecondsToSeconds, secondsToMicroseconds } from "./videoPreviewLogic";

export function useVideoPreviewState(props: VideoPreviewProps): VideoPreviewContext {
  const playbackStore = usePlaybackStore();
  const tracksStore = useTracksStore();
  const playbackSpeed = ref(1);
  const canvasContainer = ref<HTMLElement | null>(null);
  const avCanvas = shallowRef<AVCanvas | null>(null);
  const hasSprites = ref(false);
  const isPlaying = ref(false);
  const currentTime = ref(0);
  const duration = ref(secondsToMicroseconds(playbackStore.duration));
  const canvasWidth = computed(() => props.canvasWidth);
  const canvasHeight = computed(() => props.canvasHeight);
  const currentTimeInSeconds = computed(() => microsecondsToSeconds(currentTime.value));
  const durationInSeconds = computed(() => microsecondsToSeconds(duration.value));
  const flags = {
    updatingFromCanvas: false,
    updatingFromStore: false,
    syncing: false,
    pendingSync: false,
  };
  const clipSpriteMap = new Map<string, VisibleSprite>();
  const spriteListenerMap = new Map<string, () => void>();
  const clipSnapshotMap: VideoPreviewContext["clipSnapshotMap"] = new Map();
  const clipTrackMap = new Map<string, { trackId: string; trackOrder: number }>();
  const transitionInfoMap = new Map<string, TransitionInfo>();
  const clipTransitionsMap = new Map<string, TransitionInfo[]>();
  const clipFrameCache = new Map<string, ImageBitmap>();
  const avCanvasDebugData = reactive<AVCanvasDebugData>({
    initialized: false,
    canvasWidth: canvasWidth.value,
    canvasHeight: canvasHeight.value,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    playbackSpeed: 1,
    spriteCount: 0,
    sprites: [],
  });
  provide("avCanvasDebugData", avCanvasDebugData);
  return {
    props,
    playbackStore,
    tracksStore,
    playbackSpeed,
    canvasContainer,
    avCanvas,
    hasSprites,
    isPlaying,
    currentTime,
    duration,
    currentTimeInSeconds,
    durationInSeconds,
    canvasWidth,
    canvasHeight,
    flags,
    clipSpriteMap,
    spriteListenerMap,
    clipSnapshotMap,
    clipTrackMap,
    transitionInfoMap,
    clipTransitionsMap,
    clipFrameCache,
    avCanvasDebugData,
  };
}

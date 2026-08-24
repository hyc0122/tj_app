import { onMounted, onUnmounted, watch } from "vue";
import { AVCanvas } from "@webav/av-canvas";
import type { VisibleSprite } from "@webav/av-cliper";
import { syncClipsToCanvas } from "./videoCanvasSync";
import { getEffectiveDuration, syncSpriteToClip } from "./videoSpriteRegistry";
import type { VideoPreviewContext } from "./videoPreviewTypes";
import {
  secondsToMicroseconds,
  syncCanvasTimeToStore,
  syncStoreTimeToCanvas,
} from "./videoPreviewLogic";
import { clearVideoFrameCache, disposeVideoPreviewResources } from "./videoLifecycleCleanup";

export function useVideoCanvasLifecycle(
  context: VideoPreviewContext,
  emit: (event: "play" | "pause") => void,
) {
  onMounted(async () => {
    if (!context.canvasContainer.value) return;
    try {
      const canvas = new AVCanvas(context.canvasContainer.value, {
        bgColor: "#000000",
        width: context.canvasWidth.value,
        height: context.canvasHeight.value,
      });
      context.avCanvas.value = canvas;
      canvas.on("timeupdate", (time: number) => {
        syncCanvasTimeToStore(time, {
          currentTime: context.currentTime,
          isPlaying: context.isPlaying,
          flags: context.flags,
          debugData: context.avCanvasDebugData,
          seekTo: (seconds) => context.playbackStore.seekTo(seconds),
          canvas,
        });
      });
      canvas.on("playing", () => {
        context.isPlaying.value = true;
        context.avCanvasDebugData.isPlaying = true;
        context.flags.updatingFromCanvas = true;
        context.playbackStore.play();
        emit("play");
        setTimeout(() => (context.flags.updatingFromCanvas = false), 0);
      });
      canvas.on("paused", () => {
        context.isPlaying.value = false;
        context.avCanvasDebugData.isPlaying = false;
        context.flags.updatingFromCanvas = true;
        context.playbackStore.pause();
        emit("pause");
        setTimeout(() => (context.flags.updatingFromCanvas = false), 0);
      });
      canvas.on("activeSpriteChange", (sprite: VisibleSprite | null) => {
        if (!sprite) {
          context.tracksStore.clearSelection();
          return;
        }
        for (const [clipId, candidate] of context.clipSpriteMap) {
          if (candidate !== sprite) continue;
          syncSpriteToClip(context, clipId, sprite);
          context.tracksStore.selectClip(clipId);
          break;
        }
      });
      context.avCanvasDebugData.initialized = true;
      await syncClipsToCanvas(context);
      if (context.clipSpriteMap.size) canvas.previewFrame(0);
    } catch {
      // 初始化失败时保留空预览占位。
    }
  });

  watch(
    () => context.tracksStore.tracks,
    async () => {
      clearVideoFrameCache(context);
      await syncClipsToCanvas(context);
      if (context.avCanvas.value && context.clipSpriteMap.size && !context.isPlaying.value) {
        context.avCanvas.value.previewFrame(context.currentTime.value);
      }
    },
    { deep: true },
  );
  watch(
    () => context.playbackStore.currentTime,
    (time) => {
      syncStoreTimeToCanvas(time, {
        currentTime: context.currentTime,
        isPlaying: context.isPlaying,
        flags: context.flags,
        debugData: context.avCanvasDebugData,
        seekTo: (seconds) => context.playbackStore.seekTo(seconds),
        canvas: context.avCanvas.value,
      });
    },
  );
  watch(
    () => context.playbackStore.isPlaying,
    (playing) => {
      const canvas = context.avCanvas.value;
      if (context.flags.updatingFromCanvas || !canvas) return;
      if (playing && !context.isPlaying.value) {
        const effectiveDuration = getEffectiveDuration(context);
        if (effectiveDuration <= 0) return;
        if (context.currentTime.value >= effectiveDuration - 1000) context.currentTime.value = 0;
        context.flags.updatingFromStore = true;
        canvas.play({
          start: context.currentTime.value,
          end: effectiveDuration,
          playbackRate: context.playbackSpeed.value,
        });
        context.isPlaying.value = true;
        setTimeout(() => (context.flags.updatingFromStore = false), 0);
      } else if (!playing && context.isPlaying.value) {
        context.flags.updatingFromStore = true;
        canvas.pause();
        context.isPlaying.value = false;
        setTimeout(() => (context.flags.updatingFromStore = false), 0);
      }
    },
  );
  watch(
    () => context.playbackStore.duration,
    (duration) => {
      context.duration.value = secondsToMicroseconds(duration);
      context.avCanvasDebugData.duration = secondsToMicroseconds(duration);
    },
  );

  onUnmounted(() => {
    disposeVideoPreviewResources(context);
  });
}

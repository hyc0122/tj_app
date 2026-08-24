import { computed } from "vue";
import { formatTime } from "../utils/clipMeta";
import { useVideoCanvasLifecycle } from "./useVideoCanvasLifecycle";
import { useVideoPreviewState } from "./useVideoPreviewState";
import type { VideoPreviewProps } from "./videoPreviewTypes";
import {
  assertExportReady,
  pausePreviewForExport,
  secondsToMicroseconds,
} from "./videoPreviewLogic";

export function useVideoPreview(
  props: VideoPreviewProps,
  emit: (event: "play" | "pause") => void,
) {
  const context = useVideoPreviewState(props);
  useVideoCanvasLifecycle(context, emit);

  function handleSeek(event: Event) {
    const seconds = Number.parseFloat((event.target as HTMLInputElement).value);
    const microseconds = secondsToMicroseconds(seconds);
    context.currentTime.value = microseconds;
    context.flags.updatingFromCanvas = true;
    context.playbackStore.seekTo(seconds);
    setTimeout(() => (context.flags.updatingFromCanvas = false), 0);
    context.avCanvas.value?.previewFrame(microseconds);
  }

  async function exportVideo() {
    const canvas = assertExportReady(context.avCanvas.value, context.clipSpriteMap.size, $t);
    pausePreviewForExport(context.isPlaying, () => canvas.pause(), () => context.playbackStore.pause());
    const combinator = await canvas.createCombinator();
    const chunks: Uint8Array[] = [];
    const reader = combinator.output().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: "video/mp4" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `WebAV-export-${Date.now()}.mp4`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const exposed = {
    avCanvas: computed(() => context.avCanvas.value),
    exportVideo,
    addSprite: async (sprite: any) => {
      if (!context.avCanvas.value) return;
      await context.avCanvas.value.addSprite(sprite);
      context.hasSprites.value = true;
    },
    removeSprite: (sprite: any) => context.avCanvas.value?.removeSprite(sprite),
  };
  return {
    canvasContainer: context.canvasContainer,
    hasSprites: context.hasSprites,
    isPlaying: context.isPlaying,
    currentTimeInSeconds: context.currentTimeInSeconds,
    durationInSeconds: context.durationInSeconds,
    handleSeek,
    formatTime,
    exposed,
  };
}

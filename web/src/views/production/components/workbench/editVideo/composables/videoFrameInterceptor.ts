import type { Clip, MediaClip } from "vue-clip-track";
import {
  applyEffectsToFrame,
  buildCSSFilter,
  getActiveEffectsAtTime,
  getActiveFiltersAtTime,
} from "../utils/filterEffect";
import { getTransitionRenderer } from "../utils/transitionRenderers";
import { getActiveTransitionAtTime } from "./videoTransitions";
import type { VideoPreviewContext } from "./videoPreviewTypes";

export function createFilteredTickInterceptor(context: VideoPreviewContext, clip: Clip) {
  if (!["video", "image", "sticker"].includes(clip.type)) return undefined;
  const playbackRate = (clip as MediaClip).playbackRate || 1;
  let canvas: OffscreenCanvas | null = null;
  let canvasContext: OffscreenCanvasRenderingContext2D | null = null;
  let transitionCanvas: OffscreenCanvas | null = null;
  let transitionContext: OffscreenCanvasRenderingContext2D | null = null;

  return async (time: number, tickResult: any) => {
    if (!tickResult.video) return tickResult;
    const frame = tickResult.video as VideoFrame | ImageBitmap;
    const width = "displayWidth" in frame ? frame.displayWidth : frame.width;
    const height = "displayHeight" in frame ? frame.displayHeight : frame.height;
    const globalTime = clip.startTime + time / 1e6 / playbackRate;
    const transitionState = getActiveTransitionAtTime(context, globalTime, clip.id);
    const filters = getActiveFiltersAtTime(context.tracksStore.tracks, globalTime);
    const effects = getActiveEffectsAtTime(context.tracksStore.tracks, globalTime);

    async function cacheFrame(frameToCache: VideoFrame | ImageBitmap) {
      try {
        const copy = await createImageBitmap(frameToCache);
        context.clipFrameCache.get(clip.id)?.close();
        context.clipFrameCache.set(clip.id, copy);
      } catch {
        // 浏览器释放帧时缓存可能失败，不影响当前帧播放。
      }
    }

    if (transitionState && !transitionState.isBeforeClip) {
      const beforeFrame = context.clipFrameCache.get(transitionState.transition.beforeClipId);
      if (beforeFrame) {
        try {
          if (!transitionCanvas || transitionCanvas.width !== width || transitionCanvas.height !== height) {
            transitionCanvas = new OffscreenCanvas(width, height);
            transitionContext = transitionCanvas.getContext("2d");
          }
          if (transitionContext) {
            getTransitionRenderer(transitionState.transition.transitionType).render(
              transitionContext,
              beforeFrame,
              frame,
              transitionState.progress,
              width,
              height,
            );
            closeFrame(frame);
            return { ...tickResult, video: await createImageBitmap(transitionCanvas) };
          }
        } catch {
          // 转场渲染失败时回退为普通帧。
        }
      }
    }

    if (!canvas || canvas.width !== width || canvas.height !== height) {
      canvas = new OffscreenCanvas(width, height);
      canvasContext = canvas.getContext("2d");
    }
    const ctx = canvasContext;
    if (!ctx) return tickResult;

    if (transitionState?.isBeforeClip) {
      resetContext(ctx, width, height);
      ctx.filter = filters.length ? buildCSSFilter(filters) : "none";
      const effectOpacity = effects.length ? applyEffectsToFrame(effects, frame, time).opacity : 1;
      ctx.globalAlpha = effectOpacity;
      ctx.drawImage(frame, 0, 0);
      await cacheFrame(await createImageBitmap(canvas));
      if (transitionState.progress > 0) {
        resetContext(ctx, width, height);
        ctx.filter = filters.length ? buildCSSFilter(filters) : "none";
        ctx.globalAlpha = effectOpacity * (1 - transitionState.progress);
        ctx.drawImage(frame, 0, 0);
      }
      closeFrame(frame);
      return { ...tickResult, video: await createImageBitmap(canvas) };
    }

    if (!filters.length && !effects.length) {
      await cacheFrame(frame);
      return tickResult;
    }
    try {
      resetContext(ctx, width, height);
      if (filters.length) ctx.filter = buildCSSFilter(filters);
      ctx.globalAlpha = applyEffectsToFrame(effects, frame, time).opacity;
      ctx.drawImage(frame, 0, 0);
      closeFrame(frame);
      const filtered = await createImageBitmap(canvas);
      await cacheFrame(filtered);
      return { ...tickResult, video: filtered };
    } catch {
      return tickResult;
    }
  };
}

function resetContext(
  context: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
) {
  context.clearRect(0, 0, width, height);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.filter = "none";
  context.globalAlpha = 1;
}

function closeFrame(frame: VideoFrame | ImageBitmap) {
  if ("close" in frame && typeof frame.close === "function") frame.close();
}

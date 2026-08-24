import type { VisibleSprite } from "@webav/av-cliper";
import type { Clip, MediaClip, SubtitleClip, TextClip } from "vue-clip-track";
import { findClipById } from "./videoTransitions";
import type { ExtendedClip, VideoPreviewContext } from "./videoPreviewTypes";
import { calculateTrackZIndex } from "./videoPreviewLogic";

export function updateDebugSprites(context: VideoPreviewContext) {
  context.avCanvasDebugData.sprites = [...context.clipSpriteMap].map(([clipId, sprite]) => ({
    clipId,
    type: findClipById(context, clipId)?.type || "unknown",
    offset: sprite.time.offset,
    duration: sprite.time.duration,
    visible: sprite.visible,
    opacity: sprite.opacity,
    rect: {
      x: sprite.rect.x,
      y: sprite.rect.y,
      w: sprite.rect.w,
      h: sprite.rect.h,
      angle: sprite.rect.angle,
    },
    zIndex: sprite.zIndex,
  }));
  context.avCanvasDebugData.spriteCount = context.avCanvasDebugData.sprites.length;
}

export function getEffectiveDuration(context: VideoPreviewContext) {
  const spriteDuration = Math.max(
    0,
    ...[...context.clipSpriteMap.values()].map((sprite) => sprite.time.offset + sprite.time.duration),
  );
  return Math.max(spriteDuration, context.playbackStore.duration * 1e6, 0);
}

export function getClipSnapshot(clip: Clip) {
  const media = clip as MediaClip;
  const text = clip as SubtitleClip | TextClip;
  return {
    trimStart: media.trimStart || 0,
    trimEnd: media.trimEnd || 0,
    playbackRate: media.playbackRate || 1,
    sourceUrl: media.sourceUrl || "",
    text: text.text || "",
    volume: (media as any).volume ?? 1,
  };
}

export function needsRebuildSprite(context: VideoPreviewContext, clip: Clip) {
  const previous = context.clipSnapshotMap.get(clip.id);
  if (!previous) return true;
  const next = getClipSnapshot(clip);
  return Object.keys(next).some(
    (key) => previous[key as keyof typeof previous] !== next[key as keyof typeof next],
  );
}

export function syncSpriteToClip(
  context: VideoPreviewContext,
  clipId: string,
  sprite: VisibleSprite,
) {
  if (!findClipById(context, clipId)) return;
  context.flags.updatingFromCanvas = true;
  context.tracksStore.updateClip(clipId, {
    rect: {
      x: sprite.rect.x,
      y: sprite.rect.y,
      w: sprite.rect.w,
      h: sprite.rect.h,
      angle: sprite.rect.angle,
      fixedAspectRatio: sprite.rect.fixedAspectRatio,
      fixedScaleCenter: sprite.rect.fixedScaleCenter,
    },
    opacity: sprite.opacity,
    visible: sprite.visible,
    flip: sprite.flip,
    zIndex: sprite.zIndex,
  });
  setTimeout(() => (context.flags.updatingFromCanvas = false), 0);
}

export function setupSpriteListeners(
  context: VideoPreviewContext,
  clipId: string,
  sprite: VisibleSprite,
) {
  context.spriteListenerMap.get(clipId)?.();
  const unsubscribeRect = sprite.rect.on("propsChange", () => {
    if (!context.flags.updatingFromStore) syncSpriteToClip(context, clipId, sprite);
  });
  const unsubscribeSprite = sprite.on("propsChange", () => {
    if (!context.flags.updatingFromStore) syncSpriteToClip(context, clipId, sprite);
  });
  context.spriteListenerMap.set(clipId, () => {
    unsubscribeRect();
    unsubscribeSprite();
  });
}

export function applyStoredSpriteProperties(
  context: VideoPreviewContext,
  clip: Clip,
  sprite: VisibleSprite,
  originalWidth: number,
  originalHeight: number,
  track: { id: string; order: number; type: string },
) {
  const extended = clip as ExtendedClip;
  if (extended.rect && extended.rect.w > 0 && extended.rect.h > 0) {
    Object.assign(sprite.rect, extended.rect);
  } else if (originalWidth > 0 && originalHeight > 0 && !["subtitle", "text"].includes(clip.type)) {
    const scale = Math.min(
      context.canvasWidth.value / originalWidth,
      context.canvasHeight.value / originalHeight,
    );
    sprite.rect.x = (context.canvasWidth.value - originalWidth * scale) / 2;
    sprite.rect.y = (context.canvasHeight.value - originalHeight * scale) / 2;
    sprite.rect.w = originalWidth * scale;
    sprite.rect.h = originalHeight * scale;
  }
  if (extended.opacity !== undefined) sprite.opacity = extended.opacity;
  if (extended.visible !== undefined) sprite.visible = extended.visible;
  if (extended.flip) sprite.flip = extended.flip;
  const subtitle = ["subtitle", "text"].includes(track.type);
  sprite.zIndex = extended.zIndex !== undefined
    ? extended.zIndex + (subtitle ? 1000 : 0)
    : calculateTrackZIndex(track.order, subtitle);
  context.clipTrackMap.set(clip.id, { trackId: track.id, trackOrder: track.order });
}

import type { Clip, Track } from "vue-clip-track";
import type { ExtendedClip, VideoPreviewContext } from "./videoPreviewTypes";
import { detectTransitions } from "./videoTransitions";
import { createSpriteFromClip } from "./videoSpriteFactory";
import {
  getClipSnapshot,
  getEffectiveDuration,
  needsRebuildSprite,
  setupSpriteListeners,
  updateDebugSprites,
} from "./videoSpriteRegistry";
import { calculateTrackZIndex } from "./videoPreviewLogic";

export async function syncClipsToCanvas(context: VideoPreviewContext) {
  const canvas = context.avCanvas.value;
  if (!canvas) return;
  if (context.flags.syncing) {
    context.flags.pendingSync = true;
    return;
  }
  context.flags.syncing = true;
  try {
    detectTransitions(context);
    const entries: Array<{ clip: Clip; track: Track }> = [];
    for (const track of context.tracksStore.tracks) {
      if (track.visible === false) continue;
      for (const clip of track.clips) {
        if (["video", "audio", "image", "sticker", "subtitle", "text"].includes(clip.type)) {
          entries.push({ clip, track });
        }
      }
    }
    const activeIds = new Set(entries.map(({ clip }) => clip.id));
    for (const [clipId, sprite] of context.clipSpriteMap) {
      if (activeIds.has(clipId)) continue;
      removeSprite(context, clipId, sprite);
    }
    for (const { clip, track } of entries) {
      let sprite = context.clipSpriteMap.get(clip.id);
      if (sprite && needsRebuildSprite(context, clip)) {
        removeSprite(context, clip.id, sprite);
        sprite = undefined;
      }
      if (sprite) updateExistingSprite(context, clip, track, sprite);
      else {
        const created = await createSpriteFromClip(context, clip, track);
        if (!created) continue;
        await canvas.addSprite(created);
        context.clipSpriteMap.set(clip.id, created);
        context.clipSnapshotMap.set(clip.id, getClipSnapshot(clip));
        setupSpriteListeners(context, clip.id, created);
      }
    }
    context.hasSprites.value = context.clipSpriteMap.size > 0;
    updateDebugSprites(context);
    const effectiveDuration = getEffectiveDuration(context);
    if (effectiveDuration > 0) {
      context.duration.value = effectiveDuration;
      context.avCanvasDebugData.duration = effectiveDuration;
    }
  } finally {
    context.flags.syncing = false;
  }
  if (context.flags.pendingSync) {
    context.flags.pendingSync = false;
    await syncClipsToCanvas(context);
  }
}

function removeSprite(
  context: VideoPreviewContext,
  clipId: string,
  sprite: import("@webav/av-cliper").VisibleSprite,
) {
  context.spriteListenerMap.get(clipId)?.();
  context.spriteListenerMap.delete(clipId);
  context.avCanvas.value?.removeSprite(sprite);
  context.clipSpriteMap.delete(clipId);
  context.clipSnapshotMap.delete(clipId);
  context.clipTrackMap.delete(clipId);
}

function updateExistingSprite(
  context: VideoPreviewContext,
  clip: Clip,
  track: Track,
  sprite: import("@webav/av-cliper").VisibleSprite,
) {
  if (context.flags.updatingFromCanvas) return;
  context.flags.updatingFromStore = true;
  const extended = clip as ExtendedClip;
  sprite.time.offset = clip.startTime * 1e6;
  sprite.time.duration = (clip.endTime - clip.startTime) * 1e6;
  if (extended.rect && extended.rect.w > 0 && extended.rect.h > 0) {
    sprite.rect.x = extended.rect.x;
    sprite.rect.y = extended.rect.y;
    sprite.rect.w = extended.rect.w;
    sprite.rect.h = extended.rect.h;
    sprite.rect.angle = extended.rect.angle || 0;
  }
  if (extended.opacity !== undefined) sprite.opacity = extended.opacity;
  if (extended.visible !== undefined) sprite.visible = extended.visible;
  if (extended.flip !== undefined) sprite.flip = extended.flip;
  const previousTrack = context.clipTrackMap.get(clip.id);
  if (previousTrack?.trackOrder !== track.order) {
    sprite.zIndex = extended.zIndex ?? calculateTrackZIndex(track.order);
    context.clipTrackMap.set(clip.id, { trackId: track.id, trackOrder: track.order });
  } else if (extended.zIndex !== undefined) {
    sprite.zIndex = extended.zIndex;
  }
  setTimeout(() => (context.flags.updatingFromStore = false), 0);
}

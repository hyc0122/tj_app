import { AudioClip, ImgClip, MP4Clip, VisibleSprite, renderTxt2ImgBitmap } from "@webav/av-cliper";
import type { Clip, MediaClip, SubtitleClip, TextClip, Track } from "vue-clip-track";
import { createFilteredTickInterceptor } from "./videoFrameInterceptor";
import { applyStoredSpriteProperties } from "./videoSpriteRegistry";
import type { ExtendedClip, VideoPreviewContext } from "./videoPreviewTypes";

export async function createSpriteFromClip(
  context: VideoPreviewContext,
  clip: Clip,
  track: Track,
): Promise<VisibleSprite | null> {
  try {
    const media = clip as MediaClip;
    let sprite: VisibleSprite | null = null;
    let width = 0;
    let height = 0;
    if (clip.type === "video" && media.sourceUrl) {
      const source = await fetchSource(media.sourceUrl);
      if (!source) return null;
      const avClip = await createTrimmedClip(
        new MP4Clip(source, { audio: { volume: (media as any).volume ?? 1 } }),
        media,
      );
      width = avClip.meta.width;
      height = avClip.meta.height;
      const interceptor = createFilteredTickInterceptor(context, clip);
      if (interceptor) avClip.tickInterceptor = interceptor as any;
      sprite = new VisibleSprite(avClip);
      setSpriteTime(sprite, clip, media.playbackRate || 1);
    } else if (clip.type === "audio" && media.sourceUrl) {
      const source = await fetchSource(media.sourceUrl);
      if (!source) return null;
      const avClip = await createTrimmedClip(
        new AudioClip(source, { volume: (media as any).volume ?? 1 }),
        media,
      );
      sprite = new VisibleSprite(avClip);
      setSpriteTime(sprite, clip, media.playbackRate || 1);
    } else if (["image", "sticker"].includes(clip.type) && media.sourceUrl) {
      const response = await fetch(media.sourceUrl);
      if (!response.ok) return null;
      const bitmap = await createImageBitmap(await response.blob());
      const imageClip = new ImgClip(bitmap);
      await imageClip.ready;
      const interceptor = createFilteredTickInterceptor(context, clip);
      if (interceptor) imageClip.tickInterceptor = interceptor as any;
      sprite = new VisibleSprite(imageClip);
      width = bitmap.width;
      height = bitmap.height;
      setSpriteTime(sprite, clip);
    } else if (["subtitle", "text"].includes(clip.type)) {
      const text = clip as SubtitleClip | TextClip;
      if (!text.text) return null;
      const fontSize = ("fontSize" in text ? text.fontSize : 48) || 48;
      const fontFamily = ("fontFamily" in text ? text.fontFamily : "Arial") || "Arial";
      const color = ("color" in text ? text.color : "white") || "white";
      const background = ("backgroundColor" in text ? text.backgroundColor : "") || "";
      const align = ("textAlign" in text ? text.textAlign : "center") || "center";
      const css = [
        `font-size:${fontSize}px`,
        `font-family:${fontFamily}`,
        `color:${color}`,
        `text-align:${align}`,
        "white-space:pre-wrap",
        "padding:8px 16px",
        background ? `background-color:${background}` : "",
      ].filter(Boolean).join(";");
      const bitmap = await renderTxt2ImgBitmap(text.text, css);
      const imageClip = new ImgClip(bitmap);
      await imageClip.ready;
      sprite = new VisibleSprite(imageClip);
      width = bitmap.width;
      height = bitmap.height;
      const extended = clip as ExtendedClip;
      if (!extended.rect || extended.rect.w <= 0 || extended.rect.h <= 0) {
        sprite.rect.x = (context.canvasWidth.value - width) / 2;
        sprite.rect.y = context.canvasHeight.value - height - 80;
        sprite.rect.w = width;
        sprite.rect.h = height;
      }
      setSpriteTime(sprite, clip);
    }
    if (!sprite) return null;
    applyStoredSpriteProperties(context, clip, sprite, width, height, track);
    return sprite;
  } catch {
    return null;
  }
}

async function fetchSource(url: string) {
  const response = await fetch(url);
  return response.ok ? response.body! : null;
}

async function createTrimmedClip<T extends { ready: Promise<unknown>; meta: { duration: number }; split: (time: number) => Promise<[T, T]> }>(
  initialClip: T,
  media: MediaClip,
): Promise<T> {
  let clip = initialClip;
  await clip.ready;
  const margin = 0.1;
  const trimStart = media.trimStart || 0;
  const originalDuration = clip.meta.duration / 1e6;
  const trimEnd = media.trimEnd || originalDuration;
  if (trimStart > margin && trimStart < originalDuration - margin) {
    try {
      const [before, after] = await clip.split(trimStart * 1e6);
      (before as any).destroy();
      clip = after;
      await clip.ready;
    } catch {
      // 边界帧不可切分时沿用当前媒体。
    }
  }
  const keepDuration = trimEnd - trimStart;
  const currentDuration = clip.meta.duration / 1e6;
  if (keepDuration > margin && keepDuration < currentDuration - margin) {
    try {
      const [keep, discard] = await clip.split(keepDuration * 1e6);
      (discard as any).destroy();
      clip = keep;
      await clip.ready;
    } catch {
      // 边界帧不可切分时沿用当前媒体。
    }
  }
  return clip;
}

function setSpriteTime(sprite: VisibleSprite, clip: Clip, playbackRate = 1) {
  sprite.time.offset = clip.startTime * 1e6;
  sprite.time.duration = (clip.endTime - clip.startTime) * 1e6;
  sprite.time.playbackRate = playbackRate;
}

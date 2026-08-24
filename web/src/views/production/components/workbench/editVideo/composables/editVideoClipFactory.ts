import type { Clip, MediaClip } from "vue-clip-track";

type Translate = (key: string) => string;
type NormalizeTime = (value: number) => number;

/**
 * 按素材类型构造时间轴片段。这里保持原页面的字段默认值与分支顺序，
 * 让拖放编排只负责副作用，便于独立验证每种片段的数据合同。
 */
export function createMediaClip(
  mediaData: any,
  trackId: string,
  startTime: number,
  duration: number,
  clipId: string,
  normalizeTime: NormalizeTime,
  translate: Translate,
): Partial<Clip> {
  const baseClip: Partial<Clip> = {
    id: clipId,
    trackId,
    startTime: normalizeTime(startTime),
    selected: false,
  };
  const endTime = normalizeTime(startTime + duration);
  const sourceUrl = mediaData.sourceUrl || mediaData.url || mediaData.id;

  if (mediaData.type === "video") {
    return {
      ...baseClip,
      type: "video",
      name: mediaData.name,
      endTime,
      sourceUrl,
      originalDuration: duration,
      trimStart: 0,
      trimEnd: duration,
      playbackRate: 1,
      thumbnails: mediaData.thumbnails || [],
    } as Partial<MediaClip>;
  }

  if (mediaData.type === "image") {
    return {
      ...baseClip,
      type: "image" as any,
      name: mediaData.name,
      endTime,
      sourceUrl,
      originalDuration: duration,
      trimStart: 0,
      trimEnd: duration,
      playbackRate: 1,
      thumbnails: mediaData.thumbnail ? [mediaData.thumbnail] : [],
    };
  }

  if (mediaData.type === "audio") {
    return {
      ...baseClip,
      type: "audio",
      name: mediaData.name,
      endTime,
      sourceUrl,
      originalDuration: duration,
      trimStart: 0,
      trimEnd: duration,
      playbackRate: 1,
      volume: 1,
      waveformData: mediaData.waveformData || [],
    } as Partial<MediaClip>;
  }

  if (mediaData.type === "subtitle") {
    return {
      ...baseClip,
      type: "subtitle",
      name: mediaData.name,
      endTime,
      text: translate("workbench.production.editVideo.sampleSubtitle"),
    };
  }

  if (mediaData.type === "text") {
    return {
      ...baseClip,
      type: "text",
      name: mediaData.name,
      endTime,
      text: translate("workbench.production.editVideo.customText"),
    };
  }

  if (mediaData.type === "sticker") {
    return { ...baseClip, type: "sticker", name: mediaData.name, endTime, sourceUrl: mediaData.id };
  }

  if (mediaData.type === "filter") {
    return {
      ...baseClip,
      type: "filter",
      name: mediaData.name,
      endTime,
      filterType: mediaData.filterType || mediaData.id,
      filterValue: mediaData.filterValue ?? 1,
    };
  }

  if (mediaData.type === "effect") {
    return {
      ...baseClip,
      type: "effect",
      name: mediaData.name,
      endTime,
      effectType: mediaData.effectType || mediaData.id,
      effectDuration: duration,
    };
  }

  return baseClip;
}

export type MediaType = "image" | "video" | "audio" | "unknown";

export interface AssetRecord {
  id: number;
  assetsId?: number | null;
  name?: string;
  prompt?: string;
  describe?: string;
  remark?: string;
  src?: string;
  type?: "role" | "tool" | "scene" | "clip" | "audio";
  state?: string;
  sonAssets?: AssetRecord[];
  imageId?: number;
  promptState?: string;
  filePath?: string;
  sex?: string;
  startTime?: string;
}

export function getMediaType(src?: string): MediaType {
  if (!src) return "unknown";
  // URL 可能带查询参数或媒体时间锚点，识别时只取真实扩展名。
  const cleanUrl = src.split(/[?#]/, 1)[0];
  const extension = cleanUrl.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(extension)) return "image";
  if (["mp4", "webm", "ogg", "mov", "avi", "mkv"].includes(extension)) return "video";
  if (["mp3", "wav", "ogg", "aac", "flac", "m4a"].includes(extension)) return "audio";
  return "unknown";
}

export function flattenAssets<T extends { sonAssets?: T[] }>(rows: T[]): T[] {
  return rows.flatMap((row) => [row, ...(row.sonAssets ?? [])]);
}

export function findAssetById<T extends { id: number; sonAssets?: T[] }>(rows: T[], id: number): T | undefined {
  return flattenAssets(rows).find((item) => item.id === id);
}

export function normalizeSelection(
  values: Array<string | number>,
  multiple: boolean,
  isGenerating: (id: number) => boolean = () => false,
): Array<string | number> {
  const available = values.filter((key) => !isGenerating(Number(key)));
  if (multiple) return available;
  return available.length ? [available[available.length - 1]] : [];
}

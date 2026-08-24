import { safeStoryboardAssetMediaUrl } from "./storyboard-media-url";
import type { StoryboardAssetType, WorkspaceAsset } from "./storyboard-workbench-types";

export interface NormalizedStoryboardAssetEnvelope {
  sourceProjectUuid: string;
  assets: WorkspaceAsset[];
}

function normalizeAssetType(value: unknown): StoryboardAssetType | null {
  const candidate = String(value ?? "");
  return ["role", "scene", "tool", "clip", "audio"].includes(candidate)
    ? candidate as StoryboardAssetType
    : null;
}

/**
 * 在 UI 边界统一兼容生产 SharedAssetDto(type/describe) 与工作台字段。
 */
export function normalizeStoryboardAssetEnvelope(
  payload: unknown,
  fallbackSourceProjectUuid: string,
): NormalizedStoryboardAssetEnvelope {
  const envelope = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as { sourceProjectUuid?: unknown; assets?: unknown }
    : null;
  const sourceProjectUuid = String(
    envelope?.sourceProjectUuid ?? fallbackSourceProjectUuid,
  ).trim();
  const rows = envelope ? envelope.assets : payload;
  if (!Array.isArray(rows)) return { sourceProjectUuid, assets: [] };

  const assets = rows.flatMap((item): WorkspaceAsset[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const assetUuid = String(row.assetUuid ?? "").trim();
    const assetType = normalizeAssetType(row.assetType ?? row.type);
    if (!assetUuid || !assetType) return [];
    const safeCoverUrl = safeStoryboardAssetMediaUrl(
      typeof row.coverUrl === "string" ? row.coverUrl : undefined,
    );
    return [{
      assetUuid,
      name: String(row.name ?? "未命名资产"),
      assetType,
      description: typeof (row.description ?? row.describe) === "string"
        ? String(row.description ?? row.describe)
        : undefined,
      coverUrl: safeCoverUrl || undefined,
      sourceProjectUuid: String(row.sourceProjectUuid ?? sourceProjectUuid).trim(),
      hasAudio: row.hasAudio === true,
    }];
  });
  return { sourceProjectUuid, assets };
}

import {
  CURRENT_VENDOR_ID,
  LEGACY_VENDOR_ID,
} from "../identity/product-identity";
import { z } from "zod";

export const UPDATE_SOURCES = [
  CURRENT_VENDOR_ID,
  "github",
  "gitee",
  "atomgit",
] as const;

export const updateRequestSchema = z.strictObject({
  source: z.enum(UPDATE_SOURCES),
});

export interface UpdateManifestItem {
  type: string;
  url: string;
}

/**
 * 当前键始终优先；只有当前产品来源缺失时才读取一次旧清单键。
 * 旧请求来源不在允许列表中，不能借兼容逻辑重新成为当前来源。
 */
export function resolveUpdateSourceData(
  data: unknown,
  source: unknown,
): UpdateManifestItem[] | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  if (
    typeof source !== "string"
    || !UPDATE_SOURCES.includes(source as (typeof UPDATE_SOURCES)[number])
  ) {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  const selected = record[source]
    ?? (source === CURRENT_VENDOR_ID ? record[LEGACY_VENDOR_ID] : undefined);
  if (!Array.isArray(selected)) return undefined;
  if (
    !selected.every((item) =>
      item
      && typeof item === "object"
      && typeof (item as Record<string, unknown>).type === "string"
      && typeof (item as Record<string, unknown>).url === "string")
  ) {
    return undefined;
  }
  return selected as UpdateManifestItem[];
}

import path from "node:path";

import { toProjectLogicalPath } from "@/utils/oss";

export interface RelatedAudioInput {
  id: number;
  name: string;
  filePath?: string | null;
}

export interface RelatedAudioDto {
  id: number;
  name: string;
  src?: string;
}

export function isSafeProjectAudioPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length <= "files/".length || !value.startsWith("files/")) {
    return false;
  }
  if (
    value.includes("\\")
    || value.includes(":")
    || value.includes("%")
    || value.includes("?")
    || value.includes("#")
    || /[\u0000-\u001f\u007f]/.test(value)
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || path.posix.normalize(value) !== value
  ) {
    return false;
  }
  const parts = value.split("/").filter(Boolean);
  if (parts[0] !== "files" || parts.some((part) => part === "." || part === "..")) {
    return false;
  }
  return true;
}

/**
 * 中文注释：先拒绝盘符/UNC/协议/编码绕过/遍历，再按 oss 兼容合同转成 files/ 逻辑路径。
 * 允许用户真实写入形态 /{legacyProjectId}/assets/audio，禁止把原始 filePath 回传前端。
 */
export function resolveSafeProjectAudioLogicalPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (
    value.includes("\\")
    || value.includes("%")
    || value.includes("?")
    || value.includes("#")
    || /[\u0000-\u001f\u007f]/.test(value)
    || /^[A-Za-z]:/.test(value)
    || /(?:^|\/)[A-Za-z]:(?:\/|$)/.test(value)
    || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
    || value.startsWith("//")
  ) {
    return null;
  }
  const segments = value.replace(/^\/+/, "").split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((part) => part === "." || part === "..")) {
    return null;
  }
  let logical: string;
  try {
    logical = toProjectLogicalPath(value);
  } catch {
    return null;
  }
  if (!isSafeProjectAudioPath(logical)) return null;
  return logical;
}

/**
 * 中文注释：绑定指向音频父资产；真实文件优先取 child.assetsId=父 id 的子资产 image。
 * 仅当没有子文件时才回退父资产自身 imageId。
 */
export async function loadBoundRoleAudioInputs(
  database: (table: string) => any,
  roleIds: readonly number[],
): Promise<Record<number, RelatedAudioInput[]>> {
  if (roleIds.length === 0) return {};
  const bindings = await database("o_assetsRole2Audio")
    .whereIn("assetsRoleId", roleIds)
    .select("assetsRoleId", "assetsAudioId");
  const parentIds = [...new Set(
    bindings.map((row: { assetsAudioId?: unknown }) => Number(row.assetsAudioId)).filter((id: number) => Number.isInteger(id) && id > 0),
  )];
  const parents = parentIds.length === 0
    ? []
    : await database("o_assets").whereIn("id", parentIds).select("id", "name", "imageId");
  const parentById = new Map<number, { id: number; name: string; imageId: number | null }>(
    parents.map((row: { id?: unknown; name?: unknown; imageId?: unknown }) => [Number(row.id), {
      id: Number(row.id),
      name: String(row.name ?? ""),
      imageId: row.imageId == null ? null : Number(row.imageId),
    }]),
  );
  const children = parentIds.length === 0
    ? []
    : await database("o_assets")
      .whereIn("assetsId", parentIds)
      .whereNotNull("imageId")
      .select("id", "assetsId", "imageId")
      .orderBy("id", "asc");
  const childImageIds = children
    .map((row: { imageId?: unknown }) => Number(row.imageId))
    .filter((id: number) => Number.isInteger(id) && id > 0);
  const parentImageIds = parents
    .map((row: { imageId?: unknown }) => Number(row.imageId))
    .filter((id: number) => Number.isInteger(id) && id > 0);
  const imageIds = [...new Set([...childImageIds, ...parentImageIds])];
  const images = imageIds.length === 0
    ? []
    : await database("o_image").whereIn("id", imageIds).select("id", "filePath");
  const pathByImageId = new Map<number, string>(
    images.map((row: { id?: unknown; filePath?: unknown }) => [Number(row.id), String(row.filePath ?? "").trim()]),
  );
  const childPathByParent = new Map<number, string>();
  for (const child of children) {
    const parentId = Number(child.assetsId);
    const filePath = pathByImageId.get(Number(child.imageId)) ?? "";
    if (!childPathByParent.has(parentId) && filePath) childPathByParent.set(parentId, filePath);
  }
  const result: Record<number, RelatedAudioInput[]> = {};
  for (const binding of bindings) {
    const roleId = Number(binding.assetsRoleId);
    const parent = parentById.get(Number(binding.assetsAudioId));
    if (!parent) continue;
    const filePath = childPathByParent.get(parent.id)
      || (parent.imageId ? pathByImageId.get(parent.imageId) : "")
      || null;
    const item: RelatedAudioInput = { id: parent.id, name: parent.name, filePath };
    if (!result[roleId]) result[roleId] = [item];
    else result[roleId].push(item);
  }
  return result;
}

export async function buildRelatedAudioDtos(
  rows: readonly RelatedAudioInput[],
  options: {
    projectUuid: string;
    getFileUrl: (logicalPath: string) => Promise<string>;
  },
): Promise<RelatedAudioDto[]> {
  const result: RelatedAudioDto[] = [];
  for (const row of rows) {
    const dto: RelatedAudioDto = {
      id: Number(row.id),
      name: String(row.name ?? ""),
    };
    const logical = resolveSafeProjectAudioLogicalPath(row.filePath);
    if (logical) {
      try {
        const src = String(await options.getFileUrl(logical)).trim();
        // 中文注释：只接受受保护 URL，禁止把盘符或 UNC 当 src。
        if (src && !/^[A-Za-z]:\\|\\\\/.test(src)) dto.src = src;
      } catch {
        // 中文注释：URL 生成失败按无试听处理，禁止把磁盘路径回传前端。
      }
    }
    result.push(dto);
  }
  void options.projectUuid;
  return result;
}

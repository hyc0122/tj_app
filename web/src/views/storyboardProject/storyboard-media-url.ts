function rejectUnsafePath(relativePath: string): never {
  throw new Error("候选媒体路径无效");
}

export function buildStoryboardMediaUrl(projectUuid: string, relativePath: string): string {
  const normalizedProjectUuid = projectUuid.trim();
  if (!normalizedProjectUuid) {
    throw new Error("缺少项目身份");
  }
  if (
    typeof relativePath !== "string"
    || !relativePath.startsWith("files/")
    || relativePath.includes("..")
    || relativePath.includes("\\")
    || /[\u0000-\u001f]/u.test(relativePath)
  ) {
    return rejectUnsafePath(relativePath);
  }

  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return rejectUnsafePath(relativePath);
  }

  // 每一级单独编码，既保留 files 路由层次，也禁止文件名逃逸到项目目录之外。
  const encodedPath = segments.map((segment) => encodeURIComponent(segment)).join("/");
  // 中文注释：登录 Cookie 只在 /api 下发送，预览必须走受保护的同源 runtime 文件路由。
  return `/api/tianjiang/runtime/projects/${encodeURIComponent(normalizedProjectUuid)}/${encodedPath}`;
}

function hasUnsafeAssetUrlPath(value: string): boolean {
  if (/[\u0000-\u001f\u007f]/u.test(value) || value.includes("\\")) return true;
  let decoded = value;
  // 最多展开四层合法百分号编码；超过上限仍含编码时保守拒绝，避免多层编码绕过。
  for (let layer = 0; layer < 4 && /%[0-9a-f]{2}/iu.test(decoded); layer += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return true;
    }
  }
  if (/%[0-9a-f]{2}/iu.test(decoded)) return true;
  return /[\u0000-\u001f\u007f]/u.test(decoded)
    || decoded.includes("\\")
    || decoded.split("/").some((segment) => segment === "." || segment === "..");
}

const REMOTE_IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp)$/iu;
const REMOTE_MEDIA_EXT = /\.(mp4|webm|mov|mkv|mp3|wav|m4a|aac|flac|ogg)$/iu;

/**
 * 视频预览只接受同源受保护 /api 路径。
 * 资产封面仍允许无凭据的 HTTPS 图片；外部视频、file/data/盘符/穿越一律拒绝。
 */
export function safeStoryboardAssetMediaUrl(value?: string): string {
  const candidate = String(value ?? "").trim();
  if (!candidate || hasUnsafeAssetUrlPath(candidate)) return "";
  if (candidate.startsWith("/")) {
    if (candidate.startsWith("//") || candidate.includes("?") || candidate.includes("#")) return "";
    return /^\/api\/tianjiang\/runtime\/projects\/[^/]+\/files\/.+/u.test(candidate) ? candidate : "";
  }
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
    const pathname = parsed.pathname;
    // 中文注释：外部视频不得写入 <video src>；封面图才允许远程 HTTPS。
    if (REMOTE_MEDIA_EXT.test(pathname)) return "";
    if (!REMOTE_IMAGE_EXT.test(pathname)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

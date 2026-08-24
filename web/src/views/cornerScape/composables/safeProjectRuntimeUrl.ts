import settingStore from "@/stores/setting";

const PROJECT_FILES_PATH = /^\/api\/tianjiang\/runtime\/projects\/[0-9a-f-]+\/files\/(?![?#])[A-Za-z0-9._/-]+$/i;

function isProtectedFilesPath(pathname: string): boolean {
  if (!PROJECT_FILES_PATH.test(pathname)) return false;
  if (pathname.includes("\\") || pathname.includes("..") || pathname.includes("//")) return false;
  if (/filePath|[A-Za-z]:\\|\\\\/.test(pathname)) return false;
  return true;
}

function resolveServiceOrigin(explicit?: string): string {
  const raw = String(explicit ?? "").trim() || String(settingStore()?.baseUrl ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

/**
 * 中文注释：相对受保护 files 路径始终允许。
 * 绝对 URL 必须与当前应用本地服务 origin 完全一致，否则拒绝；播放和下载共用此判定。
 */
export function pickSafeProjectRuntimeFileUrl(
  value: unknown,
  allowBlob = false,
  serviceOrigin?: string,
): string | undefined {
  const candidate = String(value ?? "").trim();
  if (!candidate) return undefined;
  if (allowBlob && /^blob:https?:\/\//i.test(candidate)) return candidate;
  if (isProtectedFilesPath(candidate)) return candidate;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:") return undefined;
  if (parsed.username || parsed.password) return undefined;
  if (parsed.search || parsed.hash) return undefined;
  if (!isProtectedFilesPath(parsed.pathname)) return undefined;
  const origin = resolveServiceOrigin(serviceOrigin);
  if (!origin || parsed.origin !== origin) return undefined;
  return `${parsed.origin}${parsed.pathname}`;
}

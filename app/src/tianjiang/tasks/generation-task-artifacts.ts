/**
 * 恢复链只接受规范化产物描述：禁止 Base64、Blob 或供应商大响应进入后台运行态。
 */
export type GenerationArtifactMediaType = "image" | "video" | "audio";

export interface NormalizedGenerationArtifact {
  mediaType: GenerationArtifactMediaType;
  sourceKind: "local_path" | "remote_url";
  localPath?: string;
  remoteUrl?: string;
  contentType?: string;
  sha256?: string;
  byteLength?: number;
}

export function isUsableGenerationArtifact(
  artifact: NormalizedGenerationArtifact | undefined,
): artifact is NormalizedGenerationArtifact {
  if (!artifact) return false;
  if (!["image", "video", "audio"].includes(artifact.mediaType)) return false;
  if (artifact.sourceKind === "local_path") {
    return typeof artifact.localPath === "string" && artifact.localPath.trim().length > 0;
  }
  if (artifact.sourceKind === "remote_url") {
    return typeof artifact.remoteUrl === "string" && /^https:\/\//i.test(artifact.remoteUrl);
  }
  return false;
}

export function inferArtifactMediaType(
  hint?: string,
  contentType?: string,
): GenerationArtifactMediaType {
  const mime = String(contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";
  const locator = extractLocatorPath(hint).toLowerCase();
  if (/\.(mp3|wav)(?:$|\?)/.test(locator)) return "audio";
  if (/\.(mp4|webm|mov|mkv|m4v)(?:$|\?)/.test(locator)) return "video";
  if (locator.includes("audio")) return "audio";
  if (locator.includes("video")) return "video";
  return "image";
}

function extractLocatorPath(hint?: string): string {
  const raw = String(hint ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).pathname;
  } catch {
    return raw.split("#")[0]!.split("?")[0]!;
  }
}

/**
 * pending_finalize 之前必须持久化的规范化产物描述。
 */
import type { NormalizedGenerationArtifact } from "./generation-task-artifacts";

export interface GenerationResultLocator {
  remoteUrl?: string;
  mediaType: "image" | "video" | "audio";
  sha256?: string;
  byteLength?: number;
  contentType?: string;
  stagingPath?: string;
}

export function stringifyGenerationResultLocator(locator: GenerationResultLocator): string {
  return JSON.stringify(normalizeLocator(locator));
}

export function parseGenerationResultLocator(raw: string | null | undefined): GenerationResultLocator | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return undefined;
    const mediaType = parsed.mediaType;
    if (mediaType !== "image" && mediaType !== "video" && mediaType !== "audio") return undefined;
    return normalizeLocator({
      mediaType,
      remoteUrl: typeof parsed.remoteUrl === "string" ? parsed.remoteUrl : undefined,
      sha256: typeof parsed.sha256 === "string" ? parsed.sha256 : undefined,
      byteLength: typeof parsed.byteLength === "number" ? parsed.byteLength : undefined,
      contentType: typeof parsed.contentType === "string" ? parsed.contentType : undefined,
      stagingPath: typeof parsed.stagingPath === "string" ? parsed.stagingPath : undefined,
    });
  } catch {
    return undefined;
  }
}

export function artifactFromResultLocator(locator: GenerationResultLocator): NormalizedGenerationArtifact {
  if (locator.stagingPath) {
    return {
      mediaType: locator.mediaType,
      sourceKind: "local_path",
      localPath: locator.stagingPath,
      sha256: locator.sha256,
      byteLength: locator.byteLength,
      contentType: locator.contentType,
    };
  }
  if (locator.remoteUrl && /^https:\/\//i.test(locator.remoteUrl)) {
    return {
      mediaType: locator.mediaType,
      sourceKind: "remote_url",
      remoteUrl: locator.remoteUrl,
      sha256: locator.sha256,
      byteLength: locator.byteLength,
      contentType: locator.contentType,
    };
  }
  throw new Error("完成定位信息缺少受信 URL 或 staging 路径");
}

export function locatorFromArtifact(artifact: NormalizedGenerationArtifact): GenerationResultLocator {
  return normalizeLocator({
    mediaType: artifact.mediaType,
    remoteUrl: artifact.remoteUrl,
    sha256: artifact.sha256,
    byteLength: artifact.byteLength,
    contentType: artifact.contentType,
    stagingPath: artifact.sourceKind === "local_path" ? artifact.localPath : undefined,
  });
}

function normalizeLocator(locator: GenerationResultLocator): GenerationResultLocator {
  const output: GenerationResultLocator = { mediaType: locator.mediaType };
  if (locator.remoteUrl && /^https:\/\//i.test(locator.remoteUrl.trim())) {
    output.remoteUrl = locator.remoteUrl.trim();
  }
  if (locator.sha256 && /^[0-9a-f]{64}$/i.test(locator.sha256)) {
    output.sha256 = locator.sha256.toLowerCase();
  }
  if (typeof locator.byteLength === "number" && locator.byteLength > 0) {
    output.byteLength = locator.byteLength;
  }
  if (locator.contentType && locator.contentType.trim()) {
    output.contentType = locator.contentType.trim();
  }
  if (locator.stagingPath && locator.stagingPath.trim()) {
    output.stagingPath = locator.stagingPath.trim();
  }
  return output;
}

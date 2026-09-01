/**
 * 跟踪 createObjectURL 的短生命周期 URL。
 * 项目运行态销毁时必须成组 revoke，禁止随项目切换泄漏。
 */
const urlsByOwner = new Map<string, Set<string>>();

export function isVolatileMediaSrc(src: string | undefined | null): boolean {
  if (!src) return false;
  return src.startsWith("data:") || src.startsWith("blob:");
}

export function trackObjectUrl(ownerKey: string, url: string): void {
  const owner = String(ownerKey ?? "").trim();
  if (!owner || !url.startsWith("blob:")) return;
  let bucket = urlsByOwner.get(owner);
  if (!bucket) {
    bucket = new Set();
    urlsByOwner.set(owner, bucket);
  }
  bucket.add(url);
}

export function createTrackedObjectUrl(ownerKey: string, source: Blob | MediaSource): string {
  const url = URL.createObjectURL(source);
  trackObjectUrl(ownerKey, url);
  return url;
}

export function revokeTrackedObjectUrls(ownerKey: string): number {
  const owner = String(ownerKey ?? "").trim();
  const bucket = urlsByOwner.get(owner);
  if (!bucket) return 0;
  let revoked = 0;
  for (const url of bucket) {
    try {
      URL.revokeObjectURL(url);
      revoked += 1;
    } catch {
      // 已失效的 URL 忽略
    }
  }
  urlsByOwner.delete(owner);
  return revoked;
}

export function trackedObjectUrlCount(): number {
  let total = 0;
  for (const bucket of urlsByOwner.values()) total += bucket.size;
  return total;
}

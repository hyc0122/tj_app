export interface ProjectObjectDigest {
  relativePath: string;
  size: number;
  md5: string;
  mediaType?: "database" | "image" | "video" | "audio" | "other";
}

export interface ProjectDownloadPlan {
  targetVersion: number;
  requiredObjects: ProjectObjectDigest[];
  removedPaths: string[];
  unchangedPaths: string[];
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function normalizeRelativePath(relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("项目对象路径无效");
  }
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    normalized.startsWith("/")
    || normalized.includes("://")
    || normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("项目对象路径越界");
  }
  return normalized;
}

function digestKey(item: ProjectObjectDigest): string {
  return `${item.size}:${item.md5.toLowerCase()}`;
}

/**
 * 比较本机 inventory 与远端 manifest，只保留 size/MD5 不一致或缺失的对象。
 */
export function buildProjectDownloadPlan(
  local: readonly ProjectObjectDigest[],
  remote: readonly ProjectObjectDigest[],
  targetVersion: number,
): ProjectDownloadPlan {
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 0) {
    throw new Error("项目目标版本无效");
  }
  const localByPath = new Map<string, ProjectObjectDigest>();
  for (const item of local) {
    const relativePath = normalizeRelativePath(item.relativePath);
    if (localByPath.has(relativePath)) throw new Error("本机对象路径重复");
    localByPath.set(relativePath, { ...item, relativePath, md5: item.md5.toLowerCase() });
  }
  const remoteByPath = new Map<string, ProjectObjectDigest>();
  for (const item of remote) {
    const relativePath = normalizeRelativePath(item.relativePath);
    if (remoteByPath.has(relativePath)) throw new Error("远端对象路径重复");
    remoteByPath.set(relativePath, { ...item, relativePath, md5: item.md5.toLowerCase() });
  }

  const requiredObjects: ProjectObjectDigest[] = [];
  const unchangedPaths: string[] = [];
  for (const [relativePath, remoteItem] of [...remoteByPath.entries()].sort(([left], [right]) => compareNames(left, right))) {
    const localItem = localByPath.get(relativePath);
    if (!localItem || digestKey(localItem) !== digestKey(remoteItem)) {
      requiredObjects.push(remoteItem);
    } else {
      unchangedPaths.push(relativePath);
    }
  }
  const removedPaths = [...localByPath.keys()]
    .filter((relativePath) => !remoteByPath.has(relativePath))
    .sort(compareNames);
  return {
    targetVersion,
    requiredObjects,
    removedPaths,
    unchangedPaths,
  };
}

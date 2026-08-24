export type ManifestMediaType = "image" | "video" | "audio" | "text" | "binary";

export interface LocalManifestObject {
  relativePath: string;
  size: number;
  md5: string;
}

export interface LocalManifestFile extends LocalManifestObject {
  mediaType: ManifestMediaType;
}

export interface LocalProjectManifest {
  schemaVersion: 1;
  projectUUID: string;
  version: number;
  baseVersion: number;
  createdAt: string;
  database: LocalManifestObject;
  files: LocalManifestFile[];
}

export function buildProjectManifest(input: Omit<LocalProjectManifest, "schemaVersion"> | LocalProjectManifest): LocalProjectManifest {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.projectUUID)) {
    throw new Error("项目 UUID 无效");
  }
  if (!Number.isSafeInteger(input.version) || !Number.isSafeInteger(input.baseVersion) || input.baseVersion > input.version) {
    throw new Error("清单版本无效");
  }
  if (!Number.isFinite(Date.parse(input.createdAt))) throw new Error("清单时间无效");
  validateObject(input.database);
  const seen = new Set([input.database.relativePath]);
  const files = input.files.map((file) => {
    validateObject(file);
    if (!["image", "video", "audio", "text", "binary"].includes(file.mediaType) || seen.has(file.relativePath)) {
      throw new Error("清单对象无效");
    }
    seen.add(file.relativePath);
    return { ...file };
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    schemaVersion: 1,
    projectUUID: input.projectUUID.toLowerCase(),
    version: input.version,
    baseVersion: input.baseVersion,
    createdAt: new Date(input.createdAt).toISOString().replace(".000Z", "Z"),
    database: { ...input.database },
    files,
  };
}

export function diffManifest(base: LocalProjectManifest, candidate: LocalProjectManifest): string[] {
  const before = new Map<string, string>();
  before.set(base.database.relativePath, `${base.database.size}:${base.database.md5}`);
  for (const file of base.files) before.set(file.relativePath, `${file.size}:${file.md5}`);
  const changed: string[] = [];
  const next = [candidate.database, ...candidate.files];
  for (const object of next) {
    if (before.get(object.relativePath) !== `${object.size}:${object.md5}`) changed.push(object.relativePath);
    before.delete(object.relativePath);
  }
  changed.push(...before.keys());
  return [...new Set(changed)].sort();
}

function validateObject(object: LocalManifestObject): void {
  if (
    !object.relativePath ||
    object.relativePath.startsWith("/") ||
    object.relativePath.includes("\\") ||
    object.relativePath.includes(":") ||
    object.relativePath.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !Number.isSafeInteger(object.size) ||
    object.size < 0 ||
    !/^[a-f0-9]{32}$/.test(object.md5)
  ) {
    throw new Error("清单路径无效或摘要无效");
  }
}

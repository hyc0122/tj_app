import path from "node:path";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function projectDirectory(
  dataRoot: string,
  projectUUID: string,
  userSegment: string,
): string {
  if (!uuidPattern.test(projectUUID)) throw new Error("项目 UUID 无效");
  if (!/^[a-f0-9]{32}$/i.test(userSegment)) throw new Error("项目用户目录标识无效");
  const projectsRoot = path.resolve(dataRoot, "runtime-users", userSegment, "projects");
  const target = path.resolve(projectsRoot, projectUUID);
  if (!target.startsWith(projectsRoot + path.sep)) throw new Error("项目目录越界");
  return target;
}

/** 项目媒体唯一根：runtime-users/<segment>/projects/<uuid>/files */
export function projectFilesDirectory(
  dataRoot: string,
  projectUUID: string,
  userSegment: string,
): string {
  return path.join(projectDirectory(dataRoot, projectUUID, userSegment), "files");
}

export function resolveProjectFile(
  dataRoot: string,
  projectUUID: string,
  relativePath: string,
  userSegment: string,
): string {
  if (
    !relativePath ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes(":") ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.split("/").some((part) => part === "." || part === ".." || part === "")
  ) {
    throw new Error("项目文件相对路径无效");
  }
  const filesRoot = path.join(projectDirectory(dataRoot, projectUUID, userSegment), "files");
  const target = path.resolve(filesRoot, ...relativePath.split("/"));
  if (!target.startsWith(path.resolve(filesRoot) + path.sep)) throw new Error("项目文件相对路径无效");
  return target;
}

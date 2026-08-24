import fs from "node:fs";
import path from "node:path";

/**
 * 校验项目数据库是 dataRoot 内的真实普通文件，逐级拒绝符号链接和 Windows 目录联接。
 * 任务中心会跨多个项目只读扫描，不能让本机 junction 把读取范围引到其他账号或目录。
 */
export function assertSafeProjectDatabasePath(dataRoot: string, databasePath: string): void {
  const root = path.resolve(dataRoot);
  const target = path.resolve(databasePath);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("项目数据库路径越界");
  }

  const rootDetails = fs.lstatSync(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error("项目数据根目录无效");
  }

  let current = root;
  const segments = relative.split(path.sep);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const details = fs.lstatSync(current);
    if (details.isSymbolicLink() || isReparsePoint(details)) throw new Error("项目数据库路径包含目录联接");
    const isLast = index === segments.length - 1;
    if (isLast ? !details.isFile() : !details.isDirectory()) {
      throw new Error("项目数据库路径类型无效");
    }
    if (isLast) {
      // 中文注释：SQLite 只能按路径打开，不能把连接绑定到预先取得的 fd；因此拒绝硬链接并做两次身份复核。
      if (details.nlink !== 1) throw new Error("项目数据库文件不能是硬链接");
      const realBefore = fs.realpathSync.native(current);
      if (!sameNativePath(realBefore, current)) throw new Error("项目数据库路径包含重定向");
      const after = fs.lstatSync(current);
      if (!after.isFile() || after.isSymbolicLink() || isReparsePoint(after)
        || after.nlink !== details.nlink || after.dev !== details.dev || after.ino !== details.ino) {
        throw new Error("项目数据库文件身份已变化");
      }
      const realAfter = fs.realpathSync.native(current);
      if (!sameNativePath(realAfter, current)) throw new Error("项目数据库路径包含重定向");
    }
  }
}

function isReparsePoint(stat: fs.Stats): boolean {
  const tag = (stat as fs.Stats & { reparseTag?: number }).reparseTag;
  return typeof tag === "number" && tag !== 0;
}

function sameNativePath(left: string, right: string): boolean {
  const normalize = (value: string) => path.normalize(value).replace(/[\\/]$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

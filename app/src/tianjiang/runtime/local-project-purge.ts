/**
 * 方案 B：中央回收站成功后，安全删除当前账号下的本地项目目录与运行时状态。
 * 禁止跟随 junction/symlink，禁止越权清理其他账号目录。
 */
import fs from "node:fs";
import path from "node:path";

import { projectDirectory } from "../data/paths";
import { userStorageSegment, type UserStorageIdentity } from "./user-storage-context";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface LocalPurgeHooks {
  /** 关闭该项目的 DB/同步句柄（若已打开） */
  closeProjectHandles?: (projectUuid: string) => Promise<void> | void;
  /** 从内存目录/缓存移除 */
  forgetCatalogEntry?: (projectUuid: string) => void;
}

export interface LocalPurgeResult {
  projectUuid: string;
  removed: boolean;
  alreadyAbsent: boolean;
}

/**
 * 删除当前账号 segment 内的项目目录（含 project.sqlite 与 files）。
 * 目录不存在时视为幂等成功。
 */
export async function purgeLocalProjectCopy(options: {
  dataRoot: string;
  identity: UserStorageIdentity;
  projectUuid: string;
  hooks?: LocalPurgeHooks;
}): Promise<LocalPurgeResult> {
  const projectUuid = String(options.projectUuid ?? "").toLowerCase();
  if (!UUID_RE.test(projectUuid)) {
    throw new Error("项目标识无效");
  }
  const segment = userStorageSegment(options.identity);
  const projectsRoot = path.resolve(
    options.dataRoot,
    "runtime-users",
    segment,
    "projects",
  );
  const target = projectDirectory(options.dataRoot, projectUuid, segment);
  if (!target.startsWith(projectsRoot + path.sep)) {
    throw new Error("项目目录越权");
  }

  await options.hooks?.closeProjectHandles?.(projectUuid);

  if (!fs.existsSync(target)) {
    options.hooks?.forgetCatalogEntry?.(projectUuid);
    return { projectUuid, removed: false, alreadyAbsent: true };
  }

  // 拒绝 junction/symlink 根：避免把清理引导到账号外路径。
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new Error("项目目录类型无效");
  }

  removeTreeNoFollow(target);
  options.hooks?.forgetCatalogEntry?.(projectUuid);
  return { projectUuid, removed: true, alreadyAbsent: false };
}

function removeTreeNoFollow(root: string): void {
  // 使用手动遍历 + lstat，避免 rmSync 跟随链接。
  const stack = [root];
  const files: string[] = [];
  const dirs: string[] = [];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || st.isFile()) {
      files.push(current);
      continue;
    }
    if (st.isDirectory()) {
      dirs.push(current);
      let children: string[] = [];
      try {
        children = fs.readdirSync(current);
      } catch {
        continue;
      }
      for (const name of children) {
        stack.push(path.join(current, name));
      }
    }
  }
  for (const file of files) {
    try {
      fs.unlinkSync(file);
    } catch {
      // 单文件失败向上抛，由调用方决定是否排队重试
      fs.rmSync(file, { force: true });
    }
  }
  for (const dir of dirs.reverse()) {
    try {
      fs.rmdirSync(dir);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

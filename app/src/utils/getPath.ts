import path from "path";
import isPathInside from "is-path-inside";

function resolveTestDataRoot(): string | undefined {
  const override = process.env.TIANJIANG_TEST_DATA_ROOT?.trim();
  if (!override) return undefined;
  if (!process.env.NODE_TEST_CONTEXT) {
    throw new Error("测试数据目录覆盖只允许 Node 测试进程使用");
  }
  const worktreeOverride = process.env.TIANJIANG_TEST_WORKTREE_ROOT?.trim();
  if (!worktreeOverride) {
    throw new Error("测试数据目录覆盖缺少工作树根");
  }

  const resolved = path.resolve(override);
  // 测试可临时切换 cwd，因此允许根必须由已验证包装器单独冻结。
  const worktreeRoot = path.resolve(worktreeOverride);
  const allowedTemporaryRoot = path.join(worktreeRoot, ".tmp");
  if (
    resolved === allowedTemporaryRoot
    || !isPathInside(resolved, allowedTemporaryRoot)
  ) {
    throw new Error("测试数据目录必须位于当前工作树 .tmp 的子目录内");
  }
  const currentDirectory = path.resolve(process.cwd());
  if (isPathInside(currentDirectory, allowedTemporaryRoot)) {
    // 已进入独立测试夹具时沿用夹具 data，避免多个测试共享统一 runtime-data。
    return path.join(currentDirectory, "data");
  }
  return resolved;
}

export default (fileName?: string[] | string) => {
  let basePath: string;
  if (typeof process.versions?.electron !== "undefined") {
    const { app } = require("electron");
    const userDataDir: string = app.getPath("userData");
    basePath = path.join(userDataDir, "data");
  } else {
    basePath = resolveTestDataRoot() ?? path.join(process.cwd(), "data");
  }
  if (fileName) {
    let dbPath: string;
    if (Array.isArray(fileName)) {
      dbPath = path.resolve(basePath, ...fileName);
    } else {
      dbPath = path.resolve(basePath, fileName);
    }
    if (!isPathInside(dbPath, basePath) && dbPath !== basePath) {
      throw new Error("路径逃逸错误，路径必须在数据目录内");
    }
    return dbPath;
  }
  return basePath;
};

export function isEletron() {
  if (typeof process.versions?.electron !== "undefined") {
    const { app } = require("electron");
    return true;
  } else {
    return false;
  }
}

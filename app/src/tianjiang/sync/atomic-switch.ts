import fs from "node:fs";
import path from "node:path";

import { recoveryVersionPath } from "./recovery";

export interface AtomicSwitchOptions {
  current: string;
  staging: string;
  recovery: string;
  requiredBytes: number;
  availableBytes: number;
  validate: () => Promise<boolean>;
  simulatePublishFailure?: boolean;
}

export async function atomicSwitchProject(options: AtomicSwitchOptions): Promise<string> {
  validateSwitchPaths(options);
  if (options.availableBytes < options.requiredBytes) throw new Error("磁盘空间不足");
  if (!fs.existsSync(options.current) || !fs.statSync(options.current).isDirectory()) {
    throw new Error("当前项目目录不存在");
  }
  if (!fs.existsSync(options.staging) || !fs.statSync(options.staging).isDirectory()) {
    throw new Error("暂存项目目录不存在");
  }
  if (!(await options.validate())) throw new Error("暂存项目校验失败");

  const previous = recoveryVersionPath(options.recovery);
  let currentMoved = false;
  try {
    fs.renameSync(options.current, previous);
    currentMoved = true;
    if (options.simulatePublishFailure) throw new Error("模拟发布失败");
    // 当前目录关闭并移入恢复区后，只用同文件系统 rename 发布完整暂存版本。
    fs.renameSync(options.staging, options.current);
    return previous;
  } catch (error) {
    try {
      if (!fs.existsSync(options.current) && currentMoved && fs.existsSync(previous)) {
        fs.renameSync(previous, options.current);
      }
    } catch (rollbackError) {
      throw new Error("原子切换失败且旧项目回滚失败", { cause: rollbackError });
    }
    throw new Error("原子切换失败", { cause: error });
  }
}

function validateSwitchPaths(options: AtomicSwitchOptions): void {
  if (
    !Number.isSafeInteger(options.requiredBytes)
    || !Number.isSafeInteger(options.availableBytes)
    || options.requiredBytes < 0
    || options.availableBytes < 0
  ) {
    throw new Error("磁盘空间参数无效");
  }
  const roots = [options.current, options.staging, options.recovery].map((value) => path.resolve(value));
  if (new Set(roots).size !== roots.length) throw new Error("原子切换目录不能重叠");
  for (const candidate of roots) {
    for (const other of roots) {
      if (candidate !== other && candidate.startsWith(other + path.sep)) {
        throw new Error("原子切换目录不能互相包含");
      }
    }
  }
}

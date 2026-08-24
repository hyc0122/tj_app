import fs from "node:fs";

function waitForRenameRetry(milliseconds) {
  // 同步发布脚本使用有界阻塞等待，不忙轮询，也不引入额外异步生命周期。
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  );
}

/**
 * Windows Defender 或索引器可能短暂持有刚写入的发布文件。
 * 只重试明确的临时占用错误，其他错误立即失败，且总等待时间最多约 10 秒。
 */
export function renameDirectoryAtomic(source, destination, options = {}) {
  const rename = options.renameSync ?? fs.renameSync;
  const wait = options.wait ?? waitForRenameRetry;
  const waitMilliseconds = options.waitMilliseconds ?? 50;
  const maxAttempts = options.maxAttempts ?? 201;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      const retryable = ["EACCES", "EBUSY", "EPERM"].includes(error?.code);
      if (!retryable || attempt === maxAttempts) throw error;
      wait(waitMilliseconds);
    }
  }
}

import fs from "node:fs";
import path from "node:path";

export function recoveryVersionPath(recoveryRoot: string, timestamp = Date.now()): string {
  const resolvedRoot = path.resolve(recoveryRoot);
  fs.mkdirSync(resolvedRoot, { recursive: true });
  return path.join(resolvedRoot, `previous-${timestamp}`);
}

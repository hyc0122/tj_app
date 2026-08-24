import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function verifyGeneratedDeclarations({
  spawnImpl = spawnSync,
  workingDirectory = webRoot,
} = {}) {
  // 只检查构建会重写的受跟踪声明，避免把调用者的其他工作区改动误判为生成漂移。
  const result = spawnImpl(
    "git",
    [
      "diff",
      "--exit-code",
      "HEAD",
      "--",
      "src/types/components.d.ts",
    ],
    {
      cwd: workingDirectory,
      encoding: "utf8",
      shell: false,
      stdio: "inherit",
    },
  );

  if (result.error) throw result.error;
  return Number.isInteger(result.status) ? result.status : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const status = verifyGeneratedDeclarations();
  if (status !== 0) {
    console.error(
      "业务 Web 构建生成声明与当前提交不一致，请提交确定性生成结果。",
    );
  }
  process.exitCode = status;
}

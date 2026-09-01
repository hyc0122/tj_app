import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worktreeRoot = path.resolve(appRoot, "..");
const tempRoot = path.join(worktreeRoot, ".tmp", "r");
const testDataRoot = path.join(tempRoot, "runtime-data");
const testsRoot = path.join(appRoot, "test", "tianjiang");

function normalizedPath(targetPath) {
  const resolvedPath = path.resolve(targetPath);
  return process.platform === "win32"
    ? resolvedPath.toLocaleLowerCase("en-US")
    : resolvedPath;
}

function isPathInside(parentPath, childPath) {
  const relativePath = path.relative(
    normalizedPath(parentPath),
    normalizedPath(childPath),
  );
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

export function assertSafeTempRoot({
  worktreeRoot: candidateWorktreeRoot,
  tempRoot: candidateTempRoot,
  realpathImpl = realpathSync.native,
  lstatImpl = lstatSync,
}) {
  const tempParent = path.dirname(candidateTempRoot);

  // 拒绝 Junction/符号链接，避免词法路径在 E 盘但真实 I/O 落到系统盘。
  for (const targetPath of [tempParent, candidateTempRoot]) {
    if (lstatImpl(targetPath).isSymbolicLink()) {
      throw new Error(`测试临时目录不得使用 Junction 或符号链接：${targetPath}`);
    }
  }

  const realWorktreeRoot = realpathImpl(candidateWorktreeRoot);
  const realTempRoot = realpathImpl(candidateTempRoot);
  if (!isPathInside(realWorktreeRoot, realTempRoot)) {
    throw new Error(
      `测试临时目录真实路径必须位于当前工作树内：${realTempRoot}`,
    );
  }
}

export function runTianjiangTests({
  spawnImpl = spawnSync,
  environment = process.env,
} = {}) {
  // Windows SQLite 测试包含多层 UUID 路径，必须统一使用工作树根的最短受控临时目录。
  mkdirSync(tempRoot, { recursive: true });
  assertSafeTempRoot({ worktreeRoot, tempRoot });
  if (!isPathInside(tempRoot, testDataRoot) || testDataRoot === tempRoot) {
    throw new Error(`测试运行时数据目录必须是受控 TEMP 的子目录：${testDataRoot}`);
  }
  if (existsSync(testDataRoot) && lstatSync(testDataRoot).isSymbolicLink()) {
    throw new Error(`测试运行时数据目录不得使用 Junction 或符号链接：${testDataRoot}`);
  }
  // 中文注释：每轮必须从空的账号/项目数据根启动，防止上轮 queue、sidecar、receipt
  // 被本轮严格退出门识别后造成跨轮污染；只清理已校验的 runtime-data 子目录。
  rmSync(testDataRoot, { recursive: true, force: true });
  mkdirSync(testDataRoot, { recursive: true });

  const testFiles = readdirSync(testsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => path.relative(appRoot, path.join(testsRoot, entry.name)))
    .sort();

  if (testFiles.length === 0) {
    throw new Error("未找到天将专项测试文件");
  }

  const result = spawnImpl(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      // 专项测试共享正式构建产物，必须按文件串行，禁止入口验收读取到构建中的半文件。
      "--test-concurrency=1",
      ...testFiles,
    ],
    {
      cwd: appRoot,
      env: {
        ...environment,
        // 子进程必须覆盖调用方环境，禁止回退到 C 盘或系统临时目录。
        TEMP: tempRoot,
        TMP: tempRoot,
        TMPDIR: tempRoot,
        // 静态导入全局 runtime 的路由测试也必须写入工作树 .tmp，而不是 app/data。
        TIANJIANG_TEST_DATA_ROOT: testDataRoot,
        TIANJIANG_TEST_WORKTREE_ROOT: worktreeRoot,
      },
      stdio: "inherit",
      shell: false,
    },
  );

  if (result.error) throw result.error;
  if (result.signal) throw new Error(`天将专项测试被信号终止：${result.signal}`);
  return result.status ?? 1;
}

const modulePath = normalizedPath(fileURLToPath(import.meta.url));
const entryPath = process.argv[1] ? normalizedPath(process.argv[1]) : "";
if (entryPath === modulePath) {
  process.exitCode = runTianjiangTests();
}

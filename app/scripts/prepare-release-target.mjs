import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { renameDirectoryAtomic } from "./atomic-directory-rename.mjs";
import { resolveReleaseTarget } from "./release-targets.mjs";
import { verifyReleaseTarget } from "./verify-release-target.mjs";

function fail(reason) {
  throw new Error(`发布目标归一化失败：${reason}`);
}

function compareNames(left, right) {
  return left.localeCompare(right, "en");
}

function assertNoSymbolicLinkComponents(targetPath, label) {
  const resolved = path.resolve(targetPath);
  const root = path.parse(resolved).root;
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      fail(`${label}路径不得包含符号链接`);
    }
  }
}

function readRegularFile(filePath, label) {
  assertNoSymbolicLinkComponents(filePath, label);
  if (!fs.existsSync(filePath)) fail(`${label}缺失`);
  const details = fs.lstatSync(filePath);
  if (details.isSymbolicLink()) fail(`${label}不得为符号链接`);
  if (!details.isFile()) fail(`${label}必须是普通文件`);
  if (details.size < 1) fail(`${label}不得为空文件`);

  let descriptor;
  try {
    // O_NOFOLLOW 与前置 lstat 共同阻断复制阶段跟随替换后的符号链接。
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== details.size) fail(`${label}读取期间发生变化`);
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length !== opened.size) fail(`${label}读取大小不一致`);
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertSafeDirectoryChain(directoryPath) {
  const resolved = path.resolve(directoryPath);
  const root = path.parse(resolved).root;
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current)) {
      const details = fs.lstatSync(current);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        fail("目标父目录不得包含符号链接或普通文件");
      }
    } else {
      fs.mkdirSync(current);
    }
  }
  return resolved;
}

function atomicWrite(targetPath, bytes) {
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, bytes, { flag: "wx" });
    fs.renameSync(temporaryPath, targetPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function fileKind(fileName, metadataFile) {
  if (fileName === metadataFile) return "metadata";
  if (fileName.endsWith(".blockmap")) return "blockmap";
  if (fileName.endsWith(".exe")) return "installer";
  if (fileName.endsWith(".dmg")) return "disk-image";
  if (fileName.endsWith(".zip")) return "archive";
  if (fileName.endsWith(".AppImage")) return "app-image";
  fail(`无法识别产物类型：${fileName}`);
}

/**
 * 把 Task 2 已硬门验证的单目标 dist 收敛为不可变、无绝对路径的传递包。
 */
export function prepareReleaseTarget({
  sourceRoot,
  destinationRoot,
  targetId,
  version,
  commitRenameOptions,
}) {
  // 按合同先执行 Task 2 完整硬门，任何复制都发生在验证成功之后。
  const evidence = verifyReleaseTarget({
    targetId,
    outputDirectory: sourceRoot,
    version,
  });
  const target = resolveReleaseTarget(targetId);
  if (evidence.targetId !== target.id || evidence.metadataFile !== target.metadataFile) {
    fail("验证证据与目标 ID 或 metadata 不一致");
  }

  if (typeof destinationRoot !== "string" || destinationRoot.length === 0) {
    fail("目标目录无效");
  }
  const destination = path.resolve(destinationRoot);
  if (fs.existsSync(destination)) fail("目标目录已存在，拒绝覆盖");
  const parent = assertSafeDirectoryChain(path.dirname(destination));
  const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  const source = path.resolve(sourceRoot);
  const preparedFiles = [];

  try {
    fs.mkdirSync(staging);
    const filesRoot = path.join(staging, "files");
    fs.mkdirSync(filesRoot);
    for (const fileName of [...evidence.artifacts].sort(compareNames)) {
      if (path.basename(fileName) !== fileName || fileName.includes("\\")) {
        fail("验证证据包含跨目录路径");
      }
      const bytes = readRegularFile(path.join(source, fileName), `产物 ${fileName}`);
      atomicWrite(path.join(filesRoot, fileName), bytes);
      preparedFiles.push({
        fileName,
        kind: fileKind(fileName, target.metadataFile),
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const index = {
      schemaVersion: 1,
      targetId: target.id,
      platform: target.platform,
      arch: target.arch,
      metadataFile: target.metadataFile,
      files: preparedFiles,
    };
    atomicWrite(
      path.join(staging, "target-index.json"),
      Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf8"),
    );
    renameDirectoryAtomic(staging, destination, commitRenameOptions);
    return index;
  } catch (error) {
    // staging 名称由本函数创建且严格位于已验证父目录，可安全清理半包。
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

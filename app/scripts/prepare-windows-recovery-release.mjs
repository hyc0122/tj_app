import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { verifyReleaseTarget } from "./verify-release-target.mjs";
import { buildWindowsRecoveryPublicationAttachments } from "./windows-recovery-publication-assets.mjs";

const BETA_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const WINDOWS_TARGET = Object.freeze({
  id: "windows-x64",
  platform: "windows",
  arch: "x64",
  metadataFile: "latest.yml",
});

function fail(reason) {
  throw new Error(`Windows Beta 恢复准备失败：${reason}`);
}

function compareNames(left, right) {
  return left.localeCompare(right, "en");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort(compareNames);
  const wanted = [...expected].sort(compareNames);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label}字段集合漂移`);
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

function assertSafeDirectory(directoryPath, label) {
  assertNoSymbolicLinkComponents(directoryPath, label);
  if (!fs.existsSync(directoryPath)) fail(`${label}不存在`);
  const details = fs.lstatSync(directoryPath);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    fail(`${label}必须是非符号链接目录`);
  }
  return fs.realpathSync(directoryPath);
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
        fail("输出父目录不得包含符号链接或普通文件");
      }
    } else {
      fs.mkdirSync(current);
    }
  }
  return resolved;
}

function readRegularFile(filePath, label) {
  assertNoSymbolicLinkComponents(filePath, label);
  if (!fs.existsSync(filePath)) fail(`${label}缺失`);
  const details = fs.lstatSync(filePath);
  if (details.isSymbolicLink()) fail(`${label}不得为符号链接`);
  if (!details.isFile() || details.size < 1) fail(`${label}必须是非空普通文件`);
  let descriptor;
  try {
    // lstat 与 O_NOFOLLOW 共同阻断检查后替换为符号链接的竞态。
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== details.size) fail(`${label}读取期间发生变化`);
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length !== opened.size) fail(`${label}读取大小不一致`);
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertExactEntries(directory, expected, label) {
  const actual = fs.readdirSync(directory).sort(compareNames);
  const wanted = [...expected].sort(compareNames);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label}存在缺失或额外文件`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseIndex(indexPath) {
  const bytes = readRegularFile(indexPath, "target-index.json");
  try {
    const index = JSON.parse(bytes.toString("utf8"));
    if (!isPlainObject(index)) fail("target-index.json 必须是对象");
    return { index, bytes };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Windows Beta 恢复准备失败")) throw error;
    fail("target-index.json 不是有效 JSON");
  }
}

function validateContext(context) {
  if (!isPlainObject(context)) fail("恢复上下文无效");
  assertExactKeys(context, [
    "version", "tag", "commitSha", "runId", "jobId",
    "artifactName", "artifactId", "installerSha256",
  ], "恢复上下文");
  if (typeof context.version !== "string" || !BETA_VERSION.test(context.version)) {
    fail("版本必须是 beta.N");
  }
  if (context.tag !== `v${context.version}`) fail("Tag 与版本漂移");
  if (typeof context.commitSha !== "string" || !GIT_SHA.test(context.commitSha)) {
    fail("commit SHA 必须是 40 位小写摘要");
  }
  if (typeof context.runId !== "string" || !/^\d+$/.test(context.runId)) fail("run ID 无效");
  if (typeof context.jobId !== "string" || !/^\d+$/.test(context.jobId)) fail("job ID 无效");
  if (context.artifactName !== WINDOWS_TARGET.id) fail("Artifact 名称必须是 windows-x64");
  if (typeof context.artifactId !== "string" || !/^\d+$/.test(context.artifactId)) {
    fail("Artifact ID 无效");
  }
  if (typeof context.installerSha256 !== "string" || !DIGEST.test(context.installerSha256)) {
    fail("安装包 SHA-256 摘要无效");
  }
  return context;
}

function expectedKind(fileName) {
  if (fileName === WINDOWS_TARGET.metadataFile) return "metadata";
  if (fileName.endsWith(".blockmap")) return "blockmap";
  if (fileName.endsWith(".exe")) return "installer";
  fail(`不允许的 Windows 产物 ${fileName}`);
}

function validateIndex(index, evidence, bytesByName) {
  assertExactKeys(index, ["schemaVersion", "targetId", "platform", "arch", "metadataFile", "files"], "target-index.json");
  if (
    index.schemaVersion !== 1
    || index.targetId !== WINDOWS_TARGET.id
    || index.platform !== WINDOWS_TARGET.platform
    || index.arch !== WINDOWS_TARGET.arch
    || index.metadataFile !== WINDOWS_TARGET.metadataFile
    || !Array.isArray(index.files)
  ) {
    fail("target-index.json 平台、架构或 metadata 漂移");
  }
  const expectedNames = [...evidence.artifacts].sort(compareNames);
  const indexedNames = index.files.map((entry) => entry?.fileName);
  if (
    new Set(indexedNames).size !== expectedNames.length
    || JSON.stringify(indexedNames) !== JSON.stringify(expectedNames)
  ) {
    fail("target-index.json 三项产物集合漂移");
  }
  for (const entry of index.files) {
    if (!isPlainObject(entry)) fail("target-index.json 文件项无效");
    assertExactKeys(entry, ["fileName", "kind", "size", "sha256"], "target-index.json 文件项");
    const bytes = bytesByName.get(entry.fileName);
    if (
      entry.kind !== expectedKind(entry.fileName)
      || !Number.isSafeInteger(entry.size)
      || entry.size !== bytes.length
      || typeof entry.sha256 !== "string"
      || entry.sha256 !== sha256(bytes)
    ) {
      fail(`target-index.json ${entry.fileName} 摘要、大小或类型漂移`);
    }
  }
}

function writeExclusive(filePath, bytes) {
  fs.writeFileSync(filePath, bytes, { flag: "wx" });
}

/**
 * 把原 run 的唯一 Windows x64 传递包收敛为供恢复 Release 使用的严格附件目录。
 */
export function prepareWindowsRecoveryRelease({ sourceRoot, destinationRoot, context }) {
  const validatedContext = validateContext(context);
  const source = assertSafeDirectory(path.resolve(sourceRoot), "Windows x64 传递包");
  assertExactEntries(source, ["files", "target-index.json"], "Windows x64 传递包");
  const filesRoot = assertSafeDirectory(path.join(source, "files"), "Windows x64 files");
  const evidence = verifyReleaseTarget({
    targetId: WINDOWS_TARGET.id,
    outputDirectory: filesRoot,
    version: validatedContext.version,
  });
  const artifactNames = [...evidence.artifacts].sort(compareNames);
  assertExactEntries(filesRoot, artifactNames, "Windows x64 files");
  const bytesByName = new Map(artifactNames.map((name) => [
    name,
    readRegularFile(path.join(filesRoot, name), `Windows 产物 ${name}`),
  ]));
  const { index } = parseIndex(path.join(source, "target-index.json"));
  validateIndex(index, evidence, bytesByName);
  const installerName = artifactNames.find((name) => name.endsWith(".exe"));
  if (sha256(bytesByName.get(installerName)) !== validatedContext.installerSha256) {
    fail("安装包 SHA-256 摘要漂移");
  }

  if (typeof destinationRoot !== "string" || destinationRoot.length === 0) fail("输出目录无效");
  const destination = path.resolve(destinationRoot);
  if (fs.existsSync(destination)) fail("输出目录已存在，拒绝覆盖");
  const parent = assertSafeDirectoryChain(path.dirname(destination));
  const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  // 源 Artifact 保留中文产物名；仅在 GitHub Release 出口转为稳定 ASCII 名。
  const sourceAttachments = buildWindowsRecoveryPublicationAttachments({
    index,
    bytesByName,
    version: validatedContext.version,
  });
  const attachments = [...sourceAttachments].map(([fileName, bytes]) => ({
    fileName,
    size: bytes.length,
    sha256: sha256(bytes),
  })).sort((left, right) => compareNames(left.fileName, right.fileName));
  const manifest = {
    schemaVersion: 1,
    version: validatedContext.version,
    tag: validatedContext.tag,
    platform: WINDOWS_TARGET.platform,
    arch: WINDOWS_TARGET.arch,
    commitSha: validatedContext.commitSha,
    runId: validatedContext.runId,
    jobId: validatedContext.jobId,
    artifactName: validatedContext.artifactName,
    artifactId: validatedContext.artifactId,
    installerSha256: validatedContext.installerSha256,
    attachments,
  };
  const manifestName = "windows-recovery-manifest.json";
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const sumsEntries = [...attachments, {
    fileName: manifestName,
    sha256: sha256(manifestBytes),
  }].sort((left, right) => compareNames(left.fileName, right.fileName));
  const sumsBytes = Buffer.from(
    `${sumsEntries.map((entry) => `${entry.sha256}  ${entry.fileName}`).join("\n")}\n`,
    "utf8",
  );

  try {
    fs.mkdirSync(staging);
    for (const [fileName, bytes] of sourceAttachments) writeExclusive(path.join(staging, fileName), bytes);
    writeExclusive(path.join(staging, manifestName), manifestBytes);
    writeExclusive(path.join(staging, "WINDOWS-SHA256SUMS"), sumsBytes);
    fs.renameSync(staging, destination);
  } catch (error) {
    // staging 名称由本函数创建并局限在已验证父目录，可安全清理半成品。
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    manifest,
    manifestPath: path.join(destination, manifestName),
    sha256SumsPath: path.join(destination, "WINDOWS-SHA256SUMS"),
    attachmentRoot: destination,
  };
}

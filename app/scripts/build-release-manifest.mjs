import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { RELEASE_TARGETS, resolveReleaseTarget } from "./release-targets.mjs";
import { platformReleaseKeys } from "./platform-release-contract.mjs";
import { verifyReleaseTarget } from "./verify-release-target.mjs";

const BETA_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TRUSTED_RELEASE_REPOSITORIES = new Set([
  "hyc0122/tianjiang-manchuang",
  "hyc0122/tj_app",
]);
const BETA_EXPECTED_WORKFLOW = ".github/workflows/app-release.yml";
const STABLE_EXPECTED_WORKFLOW = ".github/workflows/app-stable-release.yml";
const EXPECTED_TARGET_IDS = Object.keys(RELEASE_TARGETS).sort(compareNames);

function fail(reason) {
  throw new Error(`聚合发布清单失败：${reason}`);
}

function compareNames(left, right) {
  return left.localeCompare(right, "en");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

export function readRegularFile(filePath, label) {
  assertNoSymbolicLinkComponents(filePath, label);
  if (!fs.existsSync(filePath)) fail(`${label}缺失`);
  const details = fs.lstatSync(filePath);
  if (details.isSymbolicLink()) fail(`${label}不得为符号链接`);
  if (!details.isFile()) fail(`${label}必须是普通文件`);
  if (details.size < 1) fail(`${label}不得为空文件`);

  let descriptor;
  try {
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

function normalizedUtcIso(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/** 对 Task 1 与 GitHub Actions 传入的公开发布上下文逐字段失败关闭。 */
export function validateReleaseContext(context) {
  if (!isPlainObject(context)) fail("发布上下文无效");
  if (typeof context.version !== "string" || !BETA_VERSION.test(context.version)) {
    fail("发布上下文版本必须是 beta.N");
  }
  if (context.tag !== `v${context.version}`) fail("发布上下文 Tag 与版本不一致");
  if (context.channel !== "beta") fail("发布上下文 channel 必须是 beta");
  if (typeof context.commitSha !== "string" || !GIT_SHA.test(context.commitSha)) {
    fail("发布上下文 commitSha 必须是 40 位小写 Git SHA");
  }
  if (!TRUSTED_RELEASE_REPOSITORIES.has(context.repository)) fail("发布上下文仓库不一致");
  if (context.workflow !== BETA_EXPECTED_WORKFLOW) fail("发布上下文工作流不一致");
  if (typeof context.runId !== "string" || !/^\d+$/.test(context.runId)) {
    fail("发布上下文 runId 必须是纯数字字符串");
  }
  if (typeof context.runAttempt !== "string" || !/^\d+$/.test(context.runAttempt)) {
    fail("发布上下文 runAttempt 必须是纯数字字符串");
  }
  const utc = normalizedUtcIso(context.generatedAt);
  const expectedUtc = typeof context.generatedAt === "string" && !context.generatedAt.includes(".")
    ? context.generatedAt.replace(/Z$/, ".000Z")
    : context.generatedAt;
  if (utc === null || utc !== expectedUtc) fail("发布上下文 generatedAt 必须是有效 UTC ISO 时间");
  return context;
}

function expectedKind(fileName, metadataFile) {
  if (fileName === metadataFile) return "metadata";
  if (fileName.endsWith(".blockmap")) return "blockmap";
  if (fileName.endsWith(".exe")) return "installer";
  if (fileName.endsWith(".dmg")) return "disk-image";
  if (fileName.endsWith(".zip")) return "archive";
  if (fileName.endsWith(".AppImage")) return "app-image";
  fail(`无法识别产物类型：${fileName}`);
}

function parseIndex(indexPath) {
  const bytes = readRegularFile(indexPath, "target-index.json");
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!isPlainObject(parsed)) fail("target-index.json 必须是对象");
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("聚合发布清单失败")) throw error;
    fail("target-index.json 不是有效 JSON");
  }
}

function assertExactDirectoryEntries(root, expected, label) {
  const actual = fs.readdirSync(root).sort(compareNames);
  const sortedExpected = [...expected].sort(compareNames);
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    fail(`${label}存在缺失、多余或越界条目`);
  }
}

/**
 * 重新验证五个传递包，并返回构建 Manifest 与发布目录所需的受控普通文件快照。
 */
export function readValidatedTargets(targetsRoot, version) {
  const root = assertSafeDirectory(path.resolve(targetsRoot), "五目标根目录");
  const actualTargets = fs.readdirSync(root).sort(compareNames);
  if (
    actualTargets.length !== EXPECTED_TARGET_IDS.length
    || JSON.stringify(actualTargets) !== JSON.stringify(EXPECTED_TARGET_IDS)
  ) {
    fail("五个发布目标存在缺失、多余或重复");
  }

  const snapshots = [];
  for (const targetId of EXPECTED_TARGET_IDS) {
    snapshots.push(readValidatedTarget(path.join(root, targetId), targetId, version, "beta"));
  }
  return snapshots;
}

/**
 * 复用五目标聚合的同一套索引、metadata、普通文件与摘要硬门读取单个平台传递包。
 */
export function readValidatedTarget(targetRoot, targetId, version, channel = "beta") {
  if (channel !== "stable" && channel !== "beta") fail("单目标发布渠道无效");
  const target = resolveReleaseTarget(targetId);
  const root = assertSafeDirectory(path.resolve(targetRoot), `目标 ${targetId}`);
  assertExactDirectoryEntries(root, ["files", "target-index.json"], `目标 ${targetId}`);
  const filesRoot = assertSafeDirectory(path.join(root, "files"), `目标 ${targetId} files`);
  const index = parseIndex(path.join(root, "target-index.json"));
  if (
    index.schemaVersion !== 1
    || index.targetId !== targetId
    || index.platform !== target.platform
    || index.arch !== target.arch
    || index.metadataFile !== target.metadataFile
    || !Array.isArray(index.files)
  ) {
    fail(`目标 ${targetId} 索引与目标 ID、平台或架构不一致`);
  }

  // 索引不能替代产物硬门；发布准备前针对 files 快照再次验证 metadata 与架构。
  const evidence = verifyReleaseTarget({ targetId, outputDirectory: filesRoot, version });
  const expectedNames = [...evidence.artifacts].sort(compareNames);
  const indexedNames = index.files.map((item) => item?.fileName);
  if (
    new Set(indexedNames).size !== indexedNames.length
    || JSON.stringify(indexedNames) !== JSON.stringify([...indexedNames].sort(compareNames))
    || JSON.stringify(indexedNames) !== JSON.stringify(expectedNames)
  ) {
    fail(`目标 ${targetId} 索引文件集合缺失、重复或未按文件名排序`);
  }
  assertExactDirectoryEntries(filesRoot, expectedNames, `目标 ${targetId} files`);

  const files = [];
  for (const indexed of index.files) {
    if (!isPlainObject(indexed) || path.basename(indexed.fileName) !== indexed.fileName || indexed.fileName.includes("\\")) {
      fail(`目标 ${targetId} 索引包含越界文件名`);
    }
    const kind = expectedKind(indexed.fileName, target.metadataFile);
    if (
      indexed.kind !== kind
      || !Number.isSafeInteger(indexed.size)
      || indexed.size < 1
      || typeof indexed.sha256 !== "string"
      || !DIGEST.test(indexed.sha256)
    ) {
      fail(`目标 ${targetId} 索引字段无效`);
    }
    const sourcePath = path.join(filesRoot, indexed.fileName);
    const bytes = readRegularFile(sourcePath, `目标 ${targetId} 产物 ${indexed.fileName}`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== indexed.size || digest !== indexed.sha256) {
      fail(`目标 ${targetId} 索引 SHA-256 或大小不一致`);
    }
    const canonicalPath = `desktop/${channel}/${target.platform}/${target.arch}/${indexed.fileName}`;
    files.push({
      artifact: {
        path: canonicalPath,
        fileName: indexed.fileName,
        platform: target.platform,
        arch: target.arch,
        kind,
        size: bytes.length,
        sha256: digest,
      },
      sourcePath,
      bytes,
    });
  }
  return { target, files };
}

/** 对已解析 Manifest 自身的固定来源字段、路径和稳定排序做严格验证。 */
export function validateReleaseManifest(manifest) {
  if (!isPlainObject(manifest) || manifest.schemaVersion !== 1) fail("ReleaseManifest schemaVersion 无效");
  validateReleaseContext(manifest);
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length < 1) {
    fail("ReleaseManifest artifacts 缺失");
  }
  const paths = [];
  for (const artifact of manifest.artifacts) {
    if (!isPlainObject(artifact)) fail("ReleaseManifest artifact 无效");
    const targetId = `${artifact.platform}-${artifact.arch}`;
    const target = Object.hasOwn(RELEASE_TARGETS, targetId) ? resolveReleaseTarget(targetId) : null;
    if (!target || path.basename(artifact.fileName) !== artifact.fileName || artifact.fileName.includes("\\")) {
      fail("ReleaseManifest artifact 目标或文件名无效");
    }
    const canonicalPath = `desktop/beta/${target.platform}/${target.arch}/${artifact.fileName}`;
    if (artifact.path !== canonicalPath || artifact.path.includes("desktop/stable/")) {
      fail("ReleaseManifest 只允许 canonical desktop/beta 路径，禁止 stable path");
    }
    if (
      artifact.kind !== expectedKind(artifact.fileName, target.metadataFile)
      || !Number.isSafeInteger(artifact.size)
      || artifact.size < 1
      || typeof artifact.sha256 !== "string"
      || !DIGEST.test(artifact.sha256)
    ) {
      fail("ReleaseManifest artifact 摘要、大小或类型无效");
    }
    paths.push(artifact.path);
  }
  if (
    new Set(paths).size !== paths.length
    || JSON.stringify(paths) !== JSON.stringify([...paths].sort(compareNames))
  ) {
    fail("ReleaseManifest artifact 路径重复或排序不稳定");
  }
  return manifest;
}

/** Stable 上下文必须在读取目标目录前失败关闭。 */
export function validateStableReleaseContext(context, expectedChannel = "stable") {
  if (!isPlainObject(context)) fail("Stable 发布上下文无效");
  if (expectedChannel !== "stable" && expectedChannel !== "beta") fail("Stable 来源清单目标渠道无效");
  if (typeof context.version !== "string" || !STABLE_VERSION.test(context.version)) {
    fail("Stable 发布上下文版本必须是正式版");
  }
  if (
    context.tag !== `v${context.version}`
    || context.channel !== expectedChannel
    || context.sourceChannel !== "stable"
    || context.platform !== "windows"
    || context.arch !== "x64"
    || typeof context.commitSha !== "string"
    || !GIT_SHA.test(context.commitSha)
    || !TRUSTED_RELEASE_REPOSITORIES.has(context.repository)
    || context.workflow !== STABLE_EXPECTED_WORKFLOW
    || typeof context.runId !== "string"
    || !/^\d+$/.test(context.runId)
    || typeof context.runAttempt !== "string"
    || !/^\d+$/.test(context.runAttempt)
  ) {
    fail("Stable 发布上下文平台、来源或 GitHub Actions 字段无效");
  }
  const utc = normalizedUtcIso(context.generatedAt);
  const expectedUtc = typeof context.generatedAt === "string" && !context.generatedAt.includes(".")
    ? context.generatedAt.replace(/Z$/, ".000Z")
    : context.generatedAt;
  if (utc === null || utc !== expectedUtc) fail("Stable 发布上下文 generatedAt 必须是有效 UTC ISO 时间");
  return context;
}

/** 校验 Stable Windows schema 2 来源清单；路径由平台合同统一给出。 */
export function validateStablePlatformReleaseManifest(manifest) {
  return validateStableSourcePlatformReleaseManifest(manifest, "stable");
}

/** Stable workflow 可分别证明 Stable 原生树与 Beta 兼容晋升树。 */
export function validateStableSourcePlatformReleaseManifest(manifest, expectedChannel) {
  if (!isPlainObject(manifest) || manifest.schemaVersion !== 2) fail("Stable ReleaseManifest schemaVersion 无效");
  validateStableReleaseContext(manifest, expectedChannel);
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 3) {
    fail("Stable ReleaseManifest 必须完整覆盖 Windows installer、blockmap 与 metadata");
  }
  const prefix = path.posix.dirname(platformReleaseKeys(expectedChannel, "windows", "x64", manifest.version).nativeMetadata);
  const paths = [];
  for (const artifact of manifest.artifacts) {
    if (
      !isPlainObject(artifact)
      || artifact.platform !== "windows"
      || artifact.arch !== "x64"
      || typeof artifact.fileName !== "string"
      || path.posix.basename(artifact.fileName) !== artifact.fileName
      || artifact.path !== `${prefix}/${artifact.fileName}`
      || !["installer", "blockmap", "metadata"].includes(artifact.kind)
      || !Number.isSafeInteger(artifact.size)
      || artifact.size < 1
      || typeof artifact.sha256 !== "string"
      || !DIGEST.test(artifact.sha256)
    ) {
      fail("Stable ReleaseManifest artifact 字段或路径无效");
    }
    paths.push(artifact.path);
  }
  if (
    new Set(paths).size !== paths.length
    || JSON.stringify(paths) !== JSON.stringify([...paths].sort(compareNames))
    || manifest.artifacts.filter((artifact) => artifact.kind === "installer").length !== 1
    || manifest.artifacts.filter((artifact) => artifact.kind === "blockmap").length !== 1
    || manifest.artifacts.filter((artifact) => artifact.kind === "metadata" && artifact.fileName === "latest.yml").length !== 1
  ) {
    fail("Stable ReleaseManifest artifact 缺失、重复或排序不稳定");
  }
  return manifest;
}

function writeExclusive(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes, { flag: "wx" });
}

/** 聚合五目标、ReleaseManifest 与供 Sigstore 签署前复核的 SHA256SUMS。 */
export function buildReleaseManifest({ targetsRoot, outputRoot, context }) {
  if (context?.channel === "stable") {
    validateStableReleaseContext(context);
    const snapshot = readValidatedTarget(targetsRoot, "windows-x64", context.version, "stable");
    const artifacts = snapshot.files.map((file) => file.artifact).sort((left, right) => compareNames(left.path, right.path));
    const manifest = validateStablePlatformReleaseManifest({
      schemaVersion: 2,
      version: context.version,
      tag: context.tag,
      channel: context.channel,
      sourceChannel: context.sourceChannel,
      platform: context.platform,
      arch: context.arch,
      commitSha: context.commitSha,
      repository: context.repository,
      workflow: context.workflow,
      runId: context.runId,
      runAttempt: context.runAttempt,
      generatedAt: context.generatedAt,
      artifacts,
    });
    if (typeof outputRoot !== "string" || outputRoot.length === 0) fail("输出目录无效");
    const destination = path.resolve(outputRoot);
    if (fs.existsSync(destination)) fail("输出目录已存在，拒绝覆盖");
    const parent = assertSafeDirectoryChain(path.dirname(destination));
    const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.tmp`);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const sumsBytes = Buffer.from(
      `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n")}\n`,
      "utf8",
    );
    try {
      fs.mkdirSync(staging);
      writeExclusive(path.join(staging, "release-manifest.json"), manifestBytes);
      writeExclusive(path.join(staging, "SHA256SUMS"), sumsBytes);
      fs.renameSync(staging, destination);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    return {
      manifest,
      manifestPath: path.join(destination, "release-manifest.json"),
      sha256SumsPath: path.join(destination, "SHA256SUMS"),
    };
  }
  validateReleaseContext(context);
  const snapshots = readValidatedTargets(targetsRoot, context.version);
  const artifacts = snapshots
    .flatMap((snapshot) => snapshot.files.map((file) => file.artifact))
    .sort((left, right) => compareNames(left.path, right.path));
  const manifest = {
    schemaVersion: 1,
    version: context.version,
    tag: context.tag,
    channel: "beta",
    commitSha: context.commitSha,
    // 仓库身份取自已通过双仓库白名单校验的 GitHub Actions 上下文。
    repository: context.repository,
    workflow: BETA_EXPECTED_WORKFLOW,
    runId: context.runId,
    runAttempt: context.runAttempt,
    generatedAt: context.generatedAt,
    artifacts,
  };
  validateReleaseManifest(manifest);
  if (typeof outputRoot !== "string" || outputRoot.length === 0) fail("输出目录无效");
  const destination = path.resolve(outputRoot);
  if (fs.existsSync(destination)) fail("输出目录已存在，拒绝覆盖");
  const parent = assertSafeDirectoryChain(path.dirname(destination));
  const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const sumsBytes = Buffer.from(
    `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n")}\n`,
    "utf8",
  );

  try {
    fs.mkdirSync(staging);
    writeExclusive(path.join(staging, "release-manifest.json"), manifestBytes);
    writeExclusive(path.join(staging, "SHA256SUMS"), sumsBytes);
    fs.renameSync(staging, destination);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    manifest,
    manifestPath: path.join(destination, "release-manifest.json"),
    sha256SumsPath: path.join(destination, "SHA256SUMS"),
  };
}

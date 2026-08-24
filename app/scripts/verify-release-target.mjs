import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";

import yaml from "js-yaml";

import { resolveReleaseTarget } from "./release-targets.mjs";

function fail(reason) {
  throw new Error(`原生发布目标硬门失败：${reason}`);
}

function expectedArtifacts(target, version) {
  if (target.id === "windows-x64") {
    const setup = `天将漫创-${version}-win-x64-setup.exe`;
    return {
      artifacts: [setup, `${setup}.blockmap`],
      metadataBinaries: [setup],
      primaryArtifact: setup,
    };
  }
  if (target.platform === "macos") {
    const base = `天将漫创-${version}-mac-${target.arch}`;
    return {
      artifacts: [`${base}.dmg`, `${base}.zip`, `${base}.zip.blockmap`],
      metadataBinaries: [`${base}.dmg`, `${base}.zip`],
      primaryArtifact: `${base}.zip`,
    };
  }
  const appImage = `天将漫创-${version}-linux-${target.arch}.AppImage`;
  return {
    artifacts: [appImage, `${appImage}.blockmap`],
    metadataBinaries: [appImage],
    primaryArtifact: appImage,
  };
}

function isSameArtifactKind(target, name) {
  if (target.platform === "windows") return /(?:\.exe|\.exe\.blockmap)$/i.test(name);
  if (target.platform === "macos") {
    return /(?:\.dmg|\.zip|\.zip\.blockmap)$/i.test(name)
      || /\.dmg(?:\.[^.]+)*\.blockmap$/i.test(name);
  }
  return /(?:\.AppImage|\.AppImage\.blockmap)$/i.test(name);
}

function assertRegularNonemptyFile(filePath, label) {
  if (!existsSync(filePath)) fail(`${label}缺失`);
  const details = lstatSync(filePath);
  if (details.isSymbolicLink()) fail(`${label}不得为符号链接`);
  if (!details.isFile()) fail(`${label}必须是普通文件`);
  if (details.size === 0) fail(`${label}不得为空文件`);
  return details;
}

function decodeMetadataFileName(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label}缺少文件名`);
  let decoded;
  try {
    decoded = decodeURIComponent(value.trim());
  } catch {
    fail(`${label}不是有效的编码文件名`);
  }
  if (
    decoded === "."
    || decoded === ".."
    || decoded.includes("/")
    || decoded.includes("\\")
    || path.posix.isAbsolute(decoded)
    || path.win32.isAbsolute(decoded)
  ) {
    fail(`${label}必须是输出目录内的单一相对路径，禁止跨目录`);
  }
  return decoded;
}

function sha512Base64(filePath) {
  return createHash("sha512").update(readFileSync(filePath)).digest("base64");
}

function resolveOutputRoot(outputDirectory) {
  if (typeof outputDirectory !== "string" || !existsSync(outputDirectory)) {
    fail("输出目录不存在");
  }
  const outputDetails = lstatSync(outputDirectory);
  if (outputDetails.isSymbolicLink() || !outputDetails.isDirectory()) {
    fail("输出目录必须是非符号链接目录");
  }
  return realpathSync(outputDirectory);
}

/**
 * 只归一化锁定 builder 已确认会产生的差异文件，随后仍须执行完整发布集合验证。
 */
export function normalizeReleaseTargetArtifacts(options = {}) {
  const { targetId, outputDirectory, version } = options;
  const target = resolveReleaseTarget(targetId);
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail("版本不是受支持的 SemVer");
  }
  const outputRoot = resolveOutputRoot(outputDirectory);
  const evidence = {
    targetId: target.id,
    removedArtifacts: [],
    renamedMetadata: null,
  };

  if (target.platform === "macos") {
    const dmgBlockmap = `天将漫创-${version}-mac-${target.arch}.dmg.blockmap`;
    const blockmapPath = path.join(outputRoot, dmgBlockmap);
    if (existsSync(blockmapPath)) {
      assertRegularNonemptyFile(blockmapPath, `归一化产物 ${dmgBlockmap}`);
      // 仅删除 builder 的精确 DMG blockmap 名；任何其它相似文件保留给集合门失败关闭。
      rmSync(blockmapPath);
      evidence.removedArtifacts.push(dmgBlockmap);
    }
  }

  if (target.id === "linux-arm64") {
    const generatedPath = path.join(outputRoot, target.releaseMetadataFile);
    const canonicalPath = path.join(outputRoot, target.metadataFile);
    if (existsSync(generatedPath)) {
      assertRegularNonemptyFile(generatedPath, `归一化 metadata ${target.releaseMetadataFile}`);
      if (existsSync(canonicalPath)) {
        fail("Linux arm64 metadata 归一化目标已存在，拒绝覆盖");
      }
      renameSync(generatedPath, canonicalPath);
      assertRegularNonemptyFile(canonicalPath, `归一化 metadata ${target.metadataFile}`);
      evidence.renamedMetadata = {
        from: target.releaseMetadataFile,
        to: target.metadataFile,
      };
    }
  }
  return evidence;
}

/** 对 electron-builder 顶层原生产物及 update metadata 做逐文件反向验证。 */
export function verifyReleaseTarget(options = {}) {
  const { targetId, outputDirectory, version } = options;
  const target = resolveReleaseTarget(targetId);
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail("版本不是受支持的 SemVer");
  }
  const outputRoot = resolveOutputRoot(outputDirectory);
  const expected = expectedArtifacts(target, version);
  const expectedNames = [...expected.artifacts, target.metadataFile];
  const actualSameKind = readdirSync(outputRoot)
    .filter((name) => isSameArtifactKind(target, name) || name === target.metadataFile)
    .sort((left, right) => left.localeCompare(right, "en"));
  const expectedSameKind = [...expectedNames]
    .sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actualSameKind) !== JSON.stringify(expectedSameKind)) {
    fail(`产物集合存在缺失或额外同类产物：${actualSameKind.join(", ")}`);
  }

  for (const name of expectedNames) {
    assertRegularNonemptyFile(path.join(outputRoot, name), `产物 ${name}`);
  }

  const metadataPath = path.join(outputRoot, target.metadataFile);
  let metadata;
  try {
    metadata = yaml.load(readFileSync(metadataPath, "utf8"));
  } catch {
    fail(`${target.metadataFile} 不是有效 YAML`);
  }
  if (!metadata || typeof metadata !== "object" || metadata.version !== version) {
    fail(`${target.metadataFile} 版本与 package.json 不一致`);
  }
  if (!Array.isArray(metadata.files) || metadata.files.length !== expected.metadataBinaries.length) {
    fail(`${target.metadataFile} files 产物数量异常`);
  }

  const metadataByName = new Map();
  for (const entry of metadata.files) {
    const name = decodeMetadataFileName(entry?.url, `${target.metadataFile} files.url`);
    if (metadataByName.has(name)) fail(`${target.metadataFile} 包含重复文件项`);
    metadataByName.set(name, entry);
  }
  for (const name of expected.metadataBinaries) {
    const entry = metadataByName.get(name);
    if (!entry) fail(`${target.metadataFile} 未指向 ${name}`);
    const artifactPath = path.join(outputRoot, name);
    const details = assertRegularNonemptyFile(artifactPath, `metadata 产物 ${name}`);
    const sha512 = sha512Base64(artifactPath);
    if (entry.sha512 !== sha512) fail(`${name} SHA-512 不一致`);
    if (!Number.isSafeInteger(entry.size) || entry.size !== details.size) {
      fail(`${name} 大小不一致`);
    }
  }
  for (const name of metadataByName.keys()) {
    if (!expected.metadataBinaries.includes(name)) {
      fail(`${target.metadataFile} 指向额外或错误架构产物 ${name}`);
    }
  }

  const primaryName = decodeMetadataFileName(metadata.path, `${target.metadataFile} path`);
  if (primaryName !== expected.primaryArtifact) {
    fail(`${target.metadataFile} 主产物文件名或架构错误`);
  }
  if (metadata.sha512 !== sha512Base64(path.join(outputRoot, primaryName))) {
    fail(`${target.metadataFile} 顶层 SHA-512 不一致`);
  }

  return {
    targetId: target.id,
    version,
    artifacts: expectedNames,
    metadataFile: target.metadataFile,
    verifiedSha512Count: expected.metadataBinaries.length,
  };
}

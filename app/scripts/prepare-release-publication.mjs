import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { renameDirectoryAtomic } from "./atomic-directory-rename.mjs";
import {
  readRegularFile,
  readValidatedTargets,
  validateReleaseManifest,
} from "./build-release-manifest.mjs";
import { RELEASE_TARGETS } from "./release-targets.mjs";

const EXPECTED_TARGET_IDS = Object.keys(RELEASE_TARGETS);

function fail(reason) {
  throw new Error(`发布完成包准备失败：${reason}`);
}

function compareNames(left, right) {
  return left.localeCompare(right, "en");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(bytes, label) {
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!isPlainObject(parsed)) fail(`${label}必须是 JSON 对象`);
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("发布完成包准备失败")) throw error;
    fail(`${label}不是有效 JSON`);
  }
}

function readSigstoreBundle(bundlePath) {
  try {
    const bytes = readRegularFile(path.resolve(bundlePath), "Sigstore bundle");
    const bundle = parseJson(bytes, "Sigstore bundle");
    if (
      bundle.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json"
      || !isPlainObject(bundle.verificationMaterial)
      || !isPlainObject(bundle.messageSignature)
      || !isPlainObject(bundle.messageSignature.messageDigest)
      || bundle.messageSignature.messageDigest.algorithm !== "SHA2_256"
      || typeof bundle.messageSignature.messageDigest.digest !== "string"
      || typeof bundle.messageSignature.signature !== "string"
      || bundle.messageSignature.signature.length === 0
    ) {
      fail("Sigstore bundle 结构无效");
    }
    return { bytes, bundle };
  } catch (error) {
    if (error instanceof Error && /Sigstore bundle/.test(error.message)) throw error;
    throw error;
  }
}

function validateSigstoreBinding(bundle, manifestBytes) {
  const digest = createHash("sha256").update(manifestBytes).digest("base64");
  if (bundle.messageSignature.messageDigest.digest !== digest) {
    fail("Sigstore bundle 与 ReleaseManifest digest 不一致");
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
        fail("发布根父目录不得包含符号链接或普通文件");
      }
    } else {
      fs.mkdirSync(current);
    }
  }
  return resolved;
}

function safeOutputPath(root, ...segments) {
  const candidate = path.resolve(root, ...segments);
  const relative = path.relative(root, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("发布根越界");
  }
  return candidate;
}

function writeExclusive(root, relativePath, bytes) {
  const target = safeOutputPath(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { flag: "wx" });
}

function validateFiveTargetCoverage(manifest) {
  const actual = new Set(manifest.artifacts.map((artifact) => `${artifact.platform}-${artifact.arch}`));
  if (
    actual.size !== EXPECTED_TARGET_IDS.length
    || EXPECTED_TARGET_IDS.some((targetId) => !actual.has(targetId))
  ) {
    fail("ReleaseManifest 必须完整覆盖五个发布目标");
  }
}

function validateSha256Sums(bytes, artifacts) {
  const expected = `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n")}\n`;
  if (bytes.toString("utf8") !== expected) {
    fail("SHA256SUMS 条目存在漏项、重复、越界、顺序或摘要不一致");
  }
}

function assertManifestMatchesTargets(manifest, snapshots) {
  const expected = snapshots
    .flatMap((snapshot) => snapshot.files.map((file) => file.artifact))
    .sort((left, right) => compareNames(left.path, right.path));
  if (JSON.stringify(manifest.artifacts) !== JSON.stringify(expected)) {
    fail("ReleaseManifest 与五目标复算后的 SHA-256、大小或路径不一致");
  }
}

function githubAttachmentName(snapshot, file) {
  return file.artifact.kind === "metadata"
    ? snapshot.target.releaseMetadataFile
    : file.artifact.fileName;
}

function createReleaseRecord(manifest, snapshots) {
  return {
    schemaVersion: 1,
    version: manifest.version,
    tag: manifest.tag,
    channel: "beta",
    commitSha: manifest.commitSha,
    targets: snapshots.map((snapshot) => ({
      targetId: snapshot.target.id,
      platform: snapshot.target.platform,
      arch: snapshot.target.arch,
      nativeMetadata: `desktop/beta/${snapshot.target.platform}/${snapshot.target.arch}/${snapshot.target.metadataFile}`,
      artifacts: snapshot.files
        .filter((file) => file.artifact.kind !== "metadata")
        .map((file) => ({
          path: file.artifact.path,
          fileName: file.artifact.fileName,
          kind: file.artifact.kind,
          size: file.artifact.size,
          sha256: file.artifact.sha256,
        })),
    })),
  };
}

function createPlatformCatalog(manifest, snapshot) {
  const prefix = `desktop/beta/${snapshot.target.platform}/${snapshot.target.arch}`;
  const releaseRelative = `${prefix}/catalog/releases/${manifest.version}/release.json`;
  const release = {
    schemaVersion: 2,
    channel: "beta",
    sourceChannel: "beta",
    platform: snapshot.target.platform,
    arch: snapshot.target.arch,
    version: manifest.version,
    tag: manifest.tag,
    commitSha: manifest.commitSha,
    nativeMetadata: `${prefix}/${snapshot.target.metadataFile}`,
    artifacts: snapshot.files
      .filter((file) => file.artifact.kind !== "metadata")
      .map((file) => ({
        path: file.artifact.path,
        fileName: file.artifact.fileName,
        kind: file.artifact.kind,
        size: file.artifact.size,
        sha256: file.artifact.sha256,
      })),
  };
  const latest = {
    schemaVersion: 2,
    channel: "beta",
    platform: snapshot.target.platform,
    arch: snapshot.target.arch,
    version: manifest.version,
    release: releaseRelative,
  };
  return { releaseRelative, release, latestRelative: `${prefix}/catalog/latest.json`, latest };
}

/**
 * 把五目标与已经由公共 Sigstore 生成的 Manifest 来源证明封装为发布完成包。
 * Sigstore bundle 只证明 release-manifest.json 来源，不被解释为产品二进制代码签名。
 */
export function prepareReleasePublication({
  targetsRoot,
  manifestPath,
  sha256SumsPath,
  sigstoreBundlePath,
  destinationRoot,
  commitRenameOptions,
}) {
  const manifestBytes = readRegularFile(path.resolve(manifestPath), "ReleaseManifest");
  const sha256SumsBytes = readRegularFile(path.resolve(sha256SumsPath), "SHA256SUMS");
  const sigstore = readSigstoreBundle(sigstoreBundlePath);
  const manifest = validateReleaseManifest(parseJson(manifestBytes, "ReleaseManifest"));
  validateFiveTargetCoverage(manifest);
  validateSha256Sums(sha256SumsBytes, manifest.artifacts);
  validateSigstoreBinding(sigstore.bundle, manifestBytes);

  // 复制前重新执行五目标 metadata 硬门，并复算所有普通文件的 SHA-256 与大小。
  const snapshots = readValidatedTargets(targetsRoot, manifest.version);
  assertManifestMatchesTargets(manifest, snapshots);

  if (typeof destinationRoot !== "string" || destinationRoot.length === 0) fail("发布根无效");
  const destination = path.resolve(destinationRoot);
  if (fs.existsSync(destination)) fail("发布根已存在或为符号链接，拒绝覆盖");
  const parent = assertSafeDirectoryChain(path.dirname(destination));
  const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  const releaseRelative = `desktop/beta/catalog/releases/${manifest.version}/release.json`;
  const releaseRecord = createReleaseRecord(manifest, snapshots);
  const latestRecord = {
    schemaVersion: 1,
    version: manifest.version,
    channel: "beta",
    release: releaseRelative,
  };
  const attachmentNames = [];

  try {
    fs.mkdirSync(staging);
    for (const snapshot of snapshots) {
      for (const file of snapshot.files) {
        writeExclusive(staging, file.artifact.path, file.bytes);
        const attachmentName = githubAttachmentName(snapshot, file);
        if (attachmentNames.includes(attachmentName)) fail(`GitHub Release 附件名冲突：${attachmentName}`);
        writeExclusive(staging, `github-release/${attachmentName}`, file.bytes);
        attachmentNames.push(attachmentName);
      }

      // 每个原生目标拥有独立平台 Catalog；旧全局 Beta Catalog 仅保留兼容用途。
      const platformCatalog = createPlatformCatalog(manifest, snapshot);
      writeExclusive(
        staging,
        platformCatalog.releaseRelative,
        Buffer.from(`${JSON.stringify(platformCatalog.release, null, 2)}\n`, "utf8"),
      );
      writeExclusive(
        staging,
        platformCatalog.latestRelative,
        Buffer.from(`${JSON.stringify(platformCatalog.latest, null, 2)}\n`, "utf8"),
      );
    }

    for (const [attachmentName, bytes] of [
      ["release-manifest.json", manifestBytes],
      ["SHA256SUMS", sha256SumsBytes],
      ["release-manifest.json.sigstore.json", sigstore.bytes],
    ]) {
      if (attachmentNames.includes(attachmentName)) fail(`GitHub Release 附件名冲突：${attachmentName}`);
      writeExclusive(staging, `github-release/${attachmentName}`, bytes);
      attachmentNames.push(attachmentName);
    }

    const catalogRoot = `desktop/beta/catalog/releases/${manifest.version}`;
    writeExclusive(
      staging,
      `${catalogRoot}/release.json`,
      Buffer.from(`${JSON.stringify(releaseRecord, null, 2)}\n`, "utf8"),
    );
    writeExclusive(staging, `${catalogRoot}/release-manifest.json`, manifestBytes);
    writeExclusive(staging, `${catalogRoot}/release-manifest.json.sigstore.json`, sigstore.bytes);
    writeExclusive(staging, `${catalogRoot}/SHA256SUMS`, sha256SumsBytes);
    writeExclusive(
      staging,
      "desktop/beta/catalog/latest.json",
      Buffer.from(`${JSON.stringify(latestRecord, null, 2)}\n`, "utf8"),
    );
    renameDirectoryAtomic(staging, destination, commitRenameOptions);
  } catch (error) {
    // staging 名称由本函数创建且严格位于已验证父目录，可安全清理半包。
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    version: manifest.version,
    tag: manifest.tag,
    commitSha: manifest.commitSha,
    releaseRelative,
    githubAttachments: [...attachmentNames].sort(compareNames),
  };
}

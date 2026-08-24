import crypto, { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { renameDirectoryAtomic } from "./atomic-directory-rename.mjs";
import {
  readRegularFile,
  readValidatedTarget,
  validateStableSourcePlatformReleaseManifest,
  validateStablePlatformReleaseManifest,
} from "./build-release-manifest.mjs";
import {
  parsePlatformLatest,
  parsePlatformRelease,
  platformReleaseKeys,
} from "./platform-release-contract.mjs";

function fail(reason) {
  throw new Error(`Stable Windows 发布准备失败：${reason}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(bytes, label) {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!isPlainObject(parsed)) fail(`${label}必须是 JSON 对象`);
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Stable Windows 发布准备失败")) throw error;
    fail(`${label}不是有效 JSON`);
  }
}

function compareNames(left, right) {
  return left.localeCompare(right, "en");
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertSafeDirectoryChain(directoryPath) {
  const resolved = path.resolve(directoryPath);
  const root = path.parse(resolved).root;
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current)) {
      const details = fs.lstatSync(current);
      if (details.isSymbolicLink() || !details.isDirectory()) fail("发布根父目录包含符号链接或普通文件");
    } else {
      fs.mkdirSync(current);
    }
  }
  return resolved;
}

function writeExclusive(root, key, bytes) {
  if (typeof key !== "string" || key.includes("..") || !/^desktop\/(?:stable|beta)\/windows\/x64\//.test(key)) {
    fail("输出对象越过 Stable/Beta Windows x64 边界");
  }
  const target = path.resolve(root, ...key.split("/"));
  const relative = path.relative(root, target);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("输出对象路径越界");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { flag: "wx" });
}

function validateSigstoreBundle(bundleBytes, manifestBytes) {
  const bundle = parseJson(bundleBytes, "Sigstore bundle");
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
  const digest = crypto.createHash("sha256").update(manifestBytes).digest("base64");
  if (bundle.messageSignature.messageDigest.digest !== digest) {
    fail("Sigstore bundle 与 ReleaseManifest digest 不一致");
  }
}

function validateStableManifest(manifest, snapshot, version) {
  validateStablePlatformReleaseManifest(manifest);
  if (manifest.version !== version) fail("Stable ReleaseManifest 与发布版本不一致");
  const expected = snapshot.files
    .map((file) => file.artifact)
    .sort((left, right) => compareNames(left.path, right.path));
  if (JSON.stringify(manifest.artifacts) !== JSON.stringify(expected)) {
    fail("Stable ReleaseManifest 与 Windows x64 普通文件复算结果不一致");
  }
  return manifest;
}

function validateSums(bytes, artifacts) {
  const expected = `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n")}\n`;
  if (Buffer.from(bytes).toString("utf8") !== expected) fail("SHA256SUMS 与 Stable ReleaseManifest 不一致");
}

function channelReleaseRecord(manifest, snapshot, channel) {
  const keys = platformReleaseKeys(channel, "windows", "x64", manifest.version);
  const prefix = `desktop/${channel}/windows/x64`;
  const release = {
    schemaVersion: 2,
    channel,
    sourceChannel: "stable",
    platform: "windows",
    arch: "x64",
    version: manifest.version,
    tag: manifest.tag,
    commitSha: manifest.commitSha,
    nativeMetadata: keys.nativeMetadata,
    artifacts: snapshot.files
      .filter((file) => file.artifact.kind !== "metadata")
      .map((file) => ({
        path: `${prefix}/${file.artifact.fileName}`,
        fileName: file.artifact.fileName,
        kind: file.artifact.kind,
        size: file.artifact.size,
        sha256: file.artifact.sha256,
      })),
  };
  return parsePlatformRelease(release, { channel, platform: "windows", arch: "x64" });
}

function channelSourceManifest(manifest, snapshot, channel) {
  const prefix = path.posix.dirname(platformReleaseKeys(channel, "windows", "x64", manifest.version).nativeMetadata);
  return validateStableSourcePlatformReleaseManifest({
    ...manifest,
    channel,
    sourceChannel: "stable",
    artifacts: snapshot.files
      .map((file) => ({ ...file.artifact, path: `${prefix}/${file.artifact.fileName}` }))
      .sort((left, right) => compareNames(left.path, right.path)),
  }, channel);
}

/**
 * 复用工作流已安装的 Cosign keyless signer，为内存中的 Beta 兼容清单生成真实 Sigstore bundle。
 * 该适配器不接受密钥、证书或预制 bundle；Cosign 必须从 GitHub OIDC 环境自行取得身份。
 */
export function createCosignKeylessSigner({
  cosignExecutable = "cosign",
  temporaryRoot = path.resolve(".local", "stable-beta-cosign"),
} = {}) {
  return (manifestBytes) => {
    if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length === 0) {
      fail("Beta 来源证明待签清单无效");
    }
    fs.mkdirSync(temporaryRoot, { recursive: true });
    const signingRoot = fs.mkdtempSync(path.join(temporaryRoot, "sign-"));
    const manifestPath = path.join(signingRoot, "release-manifest.json");
    const bundlePath = path.join(signingRoot, "release-manifest.json.sigstore.json");
    try {
      fs.writeFileSync(manifestPath, manifestBytes, { flag: "wx" });
      execFileSync(cosignExecutable, [
        "sign-blob",
        "--yes",
        "--bundle",
        bundlePath,
        manifestPath,
      ], { stdio: "inherit" });
      return readRegularFile(bundlePath, "Beta Sigstore bundle");
    } catch {
      fail("Beta 来源证明 Cosign signer 执行失败");
    } finally {
      fs.rmSync(signingRoot, { recursive: true, force: true });
    }
  };
}

/**
 * 从已验证的 Windows x64 传递包原子生成 Stable 及 Stable 来源的 Beta 兼容发布树。
 */
export function preparePlatformReleasePublication({
  targetRoot,
  manifestPath,
  sha256SumsPath,
  sigstoreBundlePath,
  destinationRoot,
  channel,
  sourceChannel,
  version,
  signer,
  commitRenameOptions,
}) {
  if (channel !== "stable" || sourceChannel !== "stable") fail("本任务只批准 Stable 来源发布");
  const snapshot = readValidatedTarget(targetRoot, "windows-x64", version, "stable");
  const manifestBytes = readRegularFile(path.resolve(manifestPath), "Stable ReleaseManifest");
  const sumsBytes = readRegularFile(path.resolve(sha256SumsPath), "Stable SHA256SUMS");
  const sigstoreBytes = readRegularFile(path.resolve(sigstoreBundlePath), "Stable Sigstore bundle");
  const manifest = validateStableManifest(parseJson(manifestBytes, "Stable ReleaseManifest"), snapshot, version);
  validateSums(sumsBytes, manifest.artifacts);
  validateSigstoreBundle(sigstoreBytes, manifestBytes);
  if (typeof signer !== "function") fail("Beta 来源证明 signer 缺失，禁止伪造或复用 Stable 签名");

  const betaManifest = channelSourceManifest(manifest, snapshot, "beta");
  const betaManifestBytes = jsonBytes(betaManifest);
  const betaSumsBytes = Buffer.from(
    `${betaManifest.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n")}\n`,
    "utf8",
  );
  let betaSigstoreBytes;
  try {
    betaSigstoreBytes = signer(betaManifestBytes, {
      channel: "beta",
      sourceChannel: "stable",
      sha256SumsBytes: betaSumsBytes,
    });
  } catch {
    fail("Beta 来源证明 signer 执行失败");
  }
  if (!Buffer.isBuffer(betaSigstoreBytes)) fail("Beta 来源证明 signer 必须同步返回 Buffer");
  validateSigstoreBundle(betaSigstoreBytes, betaManifestBytes);

  if (typeof destinationRoot !== "string" || destinationRoot.length === 0) fail("发布根无效");
  const destination = path.resolve(destinationRoot);
  if (fs.existsSync(destination)) fail("发布根已存在，拒绝覆盖");
  const parent = assertSafeDirectoryChain(path.dirname(destination));
  const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.tmp`);

  try {
    fs.mkdirSync(staging);
    for (const targetChannel of ["stable", "beta"]) {
      const keys = platformReleaseKeys(targetChannel, "windows", "x64", version);
      const prefix = `desktop/${targetChannel}/windows/x64`;
      const release = channelReleaseRecord(manifest, snapshot, targetChannel);
      const latest = parsePlatformLatest({
        schemaVersion: 2,
        channel: targetChannel,
        platform: "windows",
        arch: "x64",
        version,
        release: keys.release,
      }, { channel: targetChannel, platform: "windows", arch: "x64" });

      // 复算后的普通文件先写入同父目录 staging，最终只做一次目录原子改名。
      for (const file of snapshot.files) {
        writeExclusive(staging, `${prefix}/${file.artifact.fileName}`, file.bytes);
      }
      const releaseRoot = path.posix.dirname(keys.release);
      const proof = targetChannel === "stable"
        ? { manifestBytes, sumsBytes, sigstoreBytes }
        : { manifestBytes: betaManifestBytes, sumsBytes: betaSumsBytes, sigstoreBytes: betaSigstoreBytes };
      writeExclusive(staging, keys.release, jsonBytes(release));
      // Beta 兼容树使用自身通道路径、SHA256SUMS 与独立 signer 证明，禁止复制 Stable proof。
      writeExclusive(staging, `${releaseRoot}/release-manifest.json`, proof.manifestBytes);
      writeExclusive(staging, `${releaseRoot}/SHA256SUMS`, proof.sumsBytes);
      writeExclusive(staging, `${releaseRoot}/release-manifest.json.sigstore.json`, proof.sigstoreBytes);
      writeExclusive(staging, keys.latest, jsonBytes(latest));
    }
    renameDirectoryAtomic(staging, destination, commitRenameOptions);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    version,
    tag: manifest.tag,
    commitSha: manifest.commitSha,
    channels: ["stable", "beta"],
  };
}

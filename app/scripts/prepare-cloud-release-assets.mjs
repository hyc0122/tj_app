import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readValidatedTarget } from "./build-release-manifest.mjs";
import { resolveReleaseTarget } from "./release-targets.mjs";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BETA_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SIGNING_STATUS = Object.freeze({
  windows: new Set(["signed", "unsigned"]),
  linux: new Set(["unsigned"]),
  macos: new Set(["notarized", "unsigned"]),
});

function fail(message) {
  throw new Error(`云端 Release 资产准备失败：${message}`);
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertContext(context) {
  if (!context || typeof context !== "object") fail("发布上下文缺失");
  const pattern = context.channel === "stable" ? STABLE_VERSION : context.channel === "beta" ? BETA_VERSION : null;
  if (!pattern || !pattern.test(context.version) || context.tag !== `v${context.version}`) {
    fail("Tag、渠道与版本不一致");
  }
  const expectedWorkflow = context.channel === "stable"
    ? ".github/workflows/app-stable-release.yml"
    : ".github/workflows/app-release.yml";
  if (
    context.repository !== "hyc0122/tj_app"
    || context.workflow !== expectedWorkflow
    || !/^\d+$/.test(context.runId)
    || !/^\d+$/.test(context.runAttempt)
    || !COMMIT.test(context.commitSha)
    || Number.isNaN(Date.parse(context.generatedAt))
  ) {
    fail("GitHub Actions 来源上下文无效");
  }
}

function assertTargetSet(targets) {
  if (!Array.isArray(targets) || targets.length !== 3) fail("必须恰好包含三个平台目标");
  const platforms = targets.map((target) => target.platform).sort();
  if (JSON.stringify(platforms) !== JSON.stringify(["linux", "macos", "windows"])) {
    fail("三个平台目标必须完整覆盖 Windows、Linux、macOS");
  }
  const ids = targets.map((target) => target.id);
  if (new Set(ids).size !== ids.length) fail("目标 ID 重复");
}

export function createChannelPointerBytes(context, target) {
  return jsonBytes({
    schemaVersion: 3,
    channel: context.channel,
    version: context.version,
    tag: context.tag,
    commitSha: context.commitSha,
    platform: target.platform,
    arch: target.arch,
    releaseManifest: `desktop/${context.channel}/${target.platform}/${target.arch}/catalog/releases/${context.version}/release-manifest.json`,
  });
}

/**
 * 构建 Sigstore 签署前的三平台统一清单。
 * 这里把 Electron metadata 和 catalog/latest.json 明确标成可变指针，供本地中转最后处理。
 */
export function createCloudReleaseManifest({ context, targets, signing = {} }) {
  assertContext(context);
  assertTargetSet(targets);
  const orderedTargets = [...targets].sort((left, right) => left.id.localeCompare(right.id, "en"));
  const artifacts = [];
  const releaseAssets = new Set();

  for (const target of orderedTargets) {
    const contract = resolveReleaseTarget(target.id);
    if (
      target.platform !== contract.platform
      || target.arch !== contract.arch
      || target.metadataFile !== contract.metadataFile
      || !Array.isArray(target.files)
      || target.files.length < 2
    ) {
      fail(`目标 ${target.id} 与平台合同不一致`);
    }

    for (const file of target.files) {
      if (
        typeof file.fileName !== "string"
        || path.basename(file.fileName) !== file.fileName
        || !Number.isSafeInteger(file.size)
        || file.size < 1
        || !SHA256.test(file.sha256)
      ) {
        fail(`目标 ${target.id} 文件字段无效`);
      }
      if (releaseAssets.has(file.fileName)) fail(`Release Asset 名称重复：${file.fileName}`);
      releaseAssets.add(file.fileName);
      const mutable = file.fileName === target.metadataFile;
      const targetRoot = `desktop/${context.channel}/${target.platform}/${target.arch}`;
      artifacts.push({
        releaseAsset: file.fileName,
        // Electron 原生 latest*.yml 是渠道指针；其余文件进入不可变版本目录。
        ossKey: mutable
          ? `${targetRoot}/${file.fileName}`
          : `${targetRoot}/catalog/releases/${context.version}/${file.fileName}`,
        // Electron updater 会按 latest*.yml 所在目录解析相对文件名，因此保留原样兼容对象。
        compatibilityOssKey: mutable ? null : `${targetRoot}/${file.fileName}`,
        targetId: target.id,
        platform: target.platform,
        arch: target.arch,
        kind: file.kind,
        mutable,
        size: file.size,
        sha256: file.sha256,
      });
    }

    const pointerBytes = createChannelPointerBytes(context, target);
    const pointerAsset = `latest-${target.id}.json`;
    if (releaseAssets.has(pointerAsset)) fail(`Release Asset 名称重复：${pointerAsset}`);
    releaseAssets.add(pointerAsset);
    artifacts.push({
      releaseAsset: pointerAsset,
      ossKey: `desktop/${context.channel}/${target.platform}/${target.arch}/catalog/latest.json`,
      // Catalog latest.json 也是可变渠道指针，必须显式声明不存在兼容副本路径。
      compatibilityOssKey: null,
      targetId: target.id,
      platform: target.platform,
      arch: target.arch,
      kind: "catalog-pointer",
      mutable: true,
      size: pointerBytes.length,
      sha256: sha256(pointerBytes),
    });
  }

  const signingStatus = {};
  for (const platform of ["windows", "linux", "macos"]) {
    const value = signing[platform] ?? "unsigned";
    if (!SIGNING_STATUS[platform].has(value)) fail(`${platform} 签名状态无效`);
    signingStatus[platform] = value;
  }

  return {
    schemaVersion: 3,
    repository: context.repository,
    workflow: context.workflow,
    runId: context.runId,
    runAttempt: context.runAttempt,
    version: context.version,
    tag: context.tag,
    channel: context.channel,
    commitSha: context.commitSha,
    generatedAt: context.generatedAt,
    targets: orderedTargets.map((target) => target.id),
    signing: signingStatus,
    artifacts,
  };
}

function writeExclusive(filePath, bytes) {
  fs.writeFileSync(filePath, bytes, { flag: "wx" });
}

/** 从三个 Actions Artifact 目录生成 GitHub Release 可直接上传的平面资产目录。 */
export function prepareCloudReleaseAssets({ targetsRoot, destinationRoot, context, signing = {} }) {
  const sourceRoot = path.resolve(targetsRoot);
  const destination = path.resolve(destinationRoot);
  if (fs.existsSync(destination)) fail("目标目录已存在，拒绝覆盖");

  const targetDirectories = fs.readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("release-target-"))
    .map((entry) => ({ id: entry.name.slice("release-target-".length), root: path.join(sourceRoot, entry.name) }));
  const targets = targetDirectories.map(({ id, root }) => {
    const snapshot = readValidatedTarget(root, id, context.version, context.channel);
    return {
      id,
      platform: snapshot.target.platform,
      arch: snapshot.target.arch,
      metadataFile: snapshot.target.metadataFile,
      files: snapshot.files.map((file) => ({
        fileName: file.artifact.fileName,
        kind: file.artifact.kind,
        size: file.artifact.size,
        sha256: file.artifact.sha256,
        sourcePath: file.sourcePath,
      })),
    };
  });
  const manifest = createCloudReleaseManifest({ context, targets, signing });
  const staging = `${destination}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(staging, { recursive: false });
    const assetsRoot = path.join(staging, "assets");
    fs.mkdirSync(assetsRoot);
    for (const target of targets) {
      for (const file of target.files) {
        fs.copyFileSync(file.sourcePath, path.join(assetsRoot, file.fileName), fs.constants.COPYFILE_EXCL);
      }
      const pointerName = `latest-${target.id}.json`;
      writeExclusive(path.join(assetsRoot, pointerName), createChannelPointerBytes(context, target));
    }
    const manifestBytes = jsonBytes(manifest);
    writeExclusive(path.join(assetsRoot, "release-manifest.json"), manifestBytes);
    writeExclusive(path.join(assetsRoot, "release-run-context.json"), jsonBytes({
      repository: manifest.repository,
      workflow: manifest.workflow,
      runId: manifest.runId,
      runAttempt: manifest.runAttempt,
      version: manifest.version,
      tag: manifest.tag,
      channel: manifest.channel,
      commitSha: manifest.commitSha,
      targets: manifest.targets,
      signing: manifest.signing,
    }));
    writeExclusive(path.join(assetsRoot, "SHA256SUMS"), Buffer.from(
      `${manifest.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.releaseAsset}`).join("\n")}\n`,
      "utf8",
    ));
    fs.renameSync(staging, destination);
    return { destination, manifest };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PUBLIC_REPOSITORY = "hyc0122/tj_app";
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BETA_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMON_ASSETS = Object.freeze([
  "release-manifest.json",
  "release-manifest.json.sigstore.json",
  "release-run-context.json",
  "SHA256SUMS",
]);

function fail(message) {
  throw new Error(`本地 OSS 中转校验失败：${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeId(value) {
  return String(value ?? "").trim();
}

function expectedWorkflow(channel) {
  return channel === "stable"
    ? ".github/workflows/app-stable-release.yml"
    : ".github/workflows/app-release.yml";
}

function expectedSigstoreIdentity(manifest) {
  const escapedTag = manifest.tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reusableWorkflow = "\\.github/workflows/app-cloud-release\\.yml";
  // Fulcio 证书采用 job_workflow_ref：只接受公开主分支或本次精确 Tag 上的复用工作流。
  return `^https://github\\.com/${PUBLIC_REPOSITORY}/${reusableWorkflow}@refs/(?:heads/main|tags/${escapedTag})$`;
}

function assertManifestShape(manifest) {
  if (!manifest || manifest.schemaVersion !== 3 || manifest.repository !== PUBLIC_REPOSITORY) {
    fail("ReleaseManifest 仓库或 schema 无效");
  }
  const versionPattern = manifest.channel === "stable"
    ? STABLE_VERSION
    : manifest.channel === "beta"
      ? BETA_VERSION
      : null;
  if (!versionPattern || !versionPattern.test(manifest.version) || manifest.tag !== `v${manifest.version}`) {
    fail(`${manifest.channel === "stable" ? "Stable" : "Beta"} Tag 与版本不一致`);
  }
  if (
    manifest.workflow !== expectedWorkflow(manifest.channel)
    || !/^\d+$/.test(normalizeId(manifest.runId))
    || !COMMIT_SHA.test(manifest.commitSha)
    || !Array.isArray(manifest.targets)
    || manifest.targets.length !== 3
    || !Array.isArray(manifest.artifacts)
    || manifest.artifacts.length < 6
  ) {
    fail("ReleaseManifest 来源字段无效");
  }
  const expectedTargets = [...new Set(manifest.targets)].sort((left, right) => left.localeCompare(right, "en"));
  if (
    expectedTargets.length !== 3
    || !manifest.signing
    || !["signed", "unsigned"].includes(manifest.signing.windows)
    || manifest.signing.linux !== "unsigned"
    || !["notarized", "unsigned"].includes(manifest.signing.macos)
  ) {
    fail("三平台目标或产品签名状态无效");
  }
  const names = new Set();
  for (const artifact of manifest.artifacts) {
    if (
      typeof artifact?.releaseAsset !== "string"
      || path.basename(artifact.releaseAsset) !== artifact.releaseAsset
      || names.has(artifact.releaseAsset)
      || !Number.isSafeInteger(artifact.size)
      || artifact.size < 1
      || !SHA256.test(artifact.sha256)
      || typeof artifact.ossKey !== "string"
      || artifact.ossKey.startsWith("/")
      || artifact.ossKey.includes("..")
      || typeof artifact.mutable !== "boolean"
    ) {
      fail("ReleaseManifest 资产字段无效或重复");
    }
    if (!artifact.mutable && (
      typeof artifact.compatibilityOssKey !== "string"
      || artifact.compatibilityOssKey.startsWith("/")
      || artifact.compatibilityOssKey.includes("..")
    )) {
      fail("不可变资产缺少 updater 兼容对象路径");
    }
    if (artifact.mutable && artifact.compatibilityOssKey !== null) {
      fail("渠道指针不得声明兼容对象路径");
    }
    names.add(artifact.releaseAsset);
  }
  const artifactTargets = [...new Set(manifest.artifacts.map((artifact) => artifact.targetId))]
    .sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(artifactTargets) !== JSON.stringify(expectedTargets)) {
    fail("ReleaseManifest 目标与资产覆盖不一致");
  }
}

export function validateRelayProvenance({
  requestedRunId,
  requestedChannel,
  run,
  manifest,
  remotePackageVersion,
  resolvedTagCommit,
  release,
}) {
  assertManifestShape(manifest);
  const runId = normalizeId(requestedRunId);
  if (
    runId !== normalizeId(run?.id)
    || runId !== normalizeId(manifest.runId)
    || run?.status !== "completed"
    || run?.conclusion !== "success"
  ) {
    fail("指定 GitHub Actions Run 必须 completed/success");
  }
  if (
    requestedChannel !== manifest.channel
    || run?.repository?.full_name !== PUBLIC_REPOSITORY
    || run?.path !== manifest.workflow
    || run?.head_sha !== manifest.commitSha
  ) {
    fail("Run 仓库、渠道、Workflow 或 Commit 与 Manifest 不一致");
  }
  if (remotePackageVersion !== manifest.version) {
    fail("Run Commit 的根 package.json.version 与 Manifest 版本不一致");
  }
  if (resolvedTagCommit !== manifest.commitSha) {
    fail("Git Tag 指向的 Commit 与 Run Commit 不一致");
  }
  if (
    release?.tag_name !== manifest.tag
    || release?.draft !== false
    || release?.prerelease !== (manifest.channel === "beta")
  ) {
    fail("GitHub Release 的 Tag、draft 或 Stable/Beta 属性不一致");
  }
  if (COMMIT_SHA.test(release.target_commitish ?? "") && release.target_commitish !== manifest.commitSha) {
    fail("GitHub Release target Commit 与 Run Commit 不一致");
  }
  return {
    repository: PUBLIC_REPOSITORY,
    runId,
    version: manifest.version,
    tag: manifest.tag,
    channel: manifest.channel,
    commitSha: manifest.commitSha,
  };
}

export function exactExpectedNames(manifest) {
  return [...new Set([
    ...manifest.artifacts.map((artifact) => artifact.releaseAsset),
    ...COMMON_ASSETS,
  ])].sort((left, right) => left.localeCompare(right, "en"));
}

function readRegularFile(directory, name) {
  const filePath = path.join(directory, name);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`资产不是普通文件：${name}`);
  return { filePath, bytes: fs.readFileSync(filePath), stat };
}

/**
 * 对已经下载到本机的 GitHub Release 资产做只读验证。
 * 默认验证器使用 sigstore-js；测试可以注入同签名语义的验证器。
 */
export async function verifyDownloadedPublication({ directory, manifest, verifySigstore }) {
  assertManifestShape(manifest);
  const actual = fs.readdirSync(directory).sort((left, right) => left.localeCompare(right, "en"));
  const expected = exactExpectedNames(manifest);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`Release 资产集合存在缺失或多余文件：${actual.join(",")}`);
  }

  const verified = {};
  for (const name of expected) {
    const { filePath, bytes, stat } = readRegularFile(directory, name);
    verified[name] = { filePath, size: stat.size, sha256: sha256(bytes) };
  }
  for (const artifact of manifest.artifacts) {
    const evidence = verified[artifact.releaseAsset];
    if (evidence.size !== artifact.size || evidence.sha256 !== artifact.sha256) {
      fail(`资产大小或 SHA-256 不一致：${artifact.releaseAsset}`);
    }
  }

  const manifestOnDisk = JSON.parse(fs.readFileSync(
    path.join(directory, "release-manifest.json"),
    "utf8",
  ));
  if (JSON.stringify(manifestOnDisk) !== JSON.stringify(manifest)) {
    fail("下载的 release-manifest.json 与预检 Manifest 不一致");
  }
  const expectedSums = `${manifest.artifacts.map(
    (artifact) => `${artifact.sha256}  ${artifact.releaseAsset}`,
  ).join("\n")}\n`;
  if (fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8") !== expectedSums) {
    fail("SHA256SUMS 与 ReleaseManifest 不一致");
  }
  const expectedContext = {
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
  };
  const actualContext = JSON.parse(fs.readFileSync(
    path.join(directory, "release-run-context.json"),
    "utf8",
  ));
  if (JSON.stringify(actualContext) !== JSON.stringify(expectedContext)) {
    fail("release-run-context.json 与 ReleaseManifest 不一致");
  }

  const payload = fs.readFileSync(path.join(directory, "release-manifest.json"));
  const bundle = JSON.parse(fs.readFileSync(
    path.join(directory, "release-manifest.json.sigstore.json"),
    "utf8",
  ));
  const verifier = verifySigstore ?? (async (input) => {
    const { verify } = await import("sigstore");
    await verify(input.bundle, input.payload, {
      certificateIssuer: input.issuer,
      certificateIdentityURI: input.identity,
    });
  });
  await verifier({
    payload,
    bundle,
    issuer: "https://token.actions.githubusercontent.com",
    identity: expectedSigstoreIdentity(manifest),
  });
  return { files: expected.map((name) => ({ name, ...verified[name] })), verified };
}

const FORBIDDEN_SOURCE_PATTERNS = Object.freeze([
  /node:child_process|\b(?:spawn|spawnSync|exec|execFile|fork)\s*\(/i,
  /\byarn(?:\.cmd)?\s+(?:build|dist|pack)|\belectron-builder\b/i,
  /\b(?:codesign|signtool|notarytool)\b[^\n]*(?:--sign|sign|submit)/i,
  /\b(?:Compress-Archive|tar\s+-|zip\s+)/i,
]);

/** 在启动网络请求前静态封死本地构建、签名、重打包和子进程执行面。 */
export function assertRelaySourceBoundary(sourceByFile) {
  if (!(sourceByFile instanceof Map) || sourceByFile.size < 1) fail("中转源码边界输入为空");
  for (const [fileName, source] of sourceByFile) {
    for (const pattern of FORBIDDEN_SOURCE_PATTERNS) {
      if (pattern.test(source)) fail(`${fileName} 违反本地禁止构建、重签名、重打包或子进程边界`);
    }
  }
}

export function readRelaySources(scriptRoot) {
  const sourceByFile = new Map();
  for (const entry of fs.readdirSync(scriptRoot, { withFileTypes: true })) {
    if (
      entry.isFile()
      && /^release-relay-(?!contract)[\w-]+\.mjs$/.test(entry.name)
    ) {
      sourceByFile.set(entry.name, fs.readFileSync(path.join(scriptRoot, entry.name), "utf8"));
    }
  }
  return sourceByFile;
}

export { COMMON_ASSETS, PUBLIC_REPOSITORY, assertManifestShape, expectedSigstoreIdentity };

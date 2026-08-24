import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateReleaseManifest } from "./build-release-manifest.mjs";
import {
  compareDesktopVersions,
  parsePlatformLatest,
  platformReleaseKeys,
} from "./platform-release-contract.mjs";

const OSS_REGION = "oss-cn-qingdao";
const OSS_ENDPOINT = "https://oss-cn-qingdao.aliyuncs.com";
const latestKey = "desktop/beta/catalog/latest.json";
const nativeMetadata = [
  { targetId: "windows-x64", platform: "windows", arch: "x64", key: "desktop/beta/windows/x64/latest.yml" },
  { targetId: "macos-x64", platform: "macos", arch: "x64", key: "desktop/beta/macos/x64/latest-mac.yml" },
  { targetId: "macos-arm64", platform: "macos", arch: "arm64", key: "desktop/beta/macos/arm64/latest-mac.yml" },
  { targetId: "linux-x64", platform: "linux", arch: "x64", key: "desktop/beta/linux/x64/latest-linux.yml" },
  { targetId: "linux-arm64", platform: "linux", arch: "arm64", key: "desktop/beta/linux/arm64/latest-linux.yml" },
];

/**
 * 将 Task 3 已完成的发布树提交到既有 OSS Bucket。
 * 核心事务只接收远端能力，不读取或记录任何凭据。
 */
export async function publishReleaseTransaction(options) {
  const { publicationRoot, version, remote, singleWriterProof } = options ?? {};
  const publication = loadPublication(publicationRoot, version);
  const expectedSingleWriterProof = `github-actions:${publication.repository}:${publication.runId}:beta`;
  if (singleWriterProof !== expectedSingleWriterProof) {
    throw new Error("GitHub Actions 单写者并发门证明与发布清单不匹配");
  }
  assertRemoteContract(remote);

  // forbid-overwrite 在开启版本控制时不再提供不可变语义，因此发布前必须失败关闭。
  await remote.assertImmutableUploadMode();
  const events = [];
  const currentLatest = await readRemoteObject(remote, latestKey);
  assertPublishOrder(currentLatest, publication.latestBytes, version);
  const frozenLatestDigest = currentLatest ? sha256(currentLatest) : null;
  events.push("catalog:current-frozen");
  const frozenPlatformLatest = new Map();
  for (const pointer of publication.platformCatalogPointers) {
    const current = await readRemoteObject(remote, pointer.key);
    assertPlatformPublishOrder(current, pointer.bytes, version, pointer);
    frozenPlatformLatest.set(pointer.key, current ? sha256(current) : null);
    events.push(`platform-catalog:${pointer.targetId}:current-frozen`);
  }

  // 所有不可变对象（含版本目录）必须先于任何平台或总指针完成写入。
  for (const object of publication.immutableObjects) {
    const result = await putImmutable(remote, object);
    if (result === "exists") {
      const existing = await readRemoteObject(remote, object.key);
      if (!existing || !Buffer.from(existing).equals(object.bytes)) {
        throw new Error(`OSS 不可变对象内容冲突：${object.key}`);
      }
    }
  }
  events.push("immutable:all-uploaded");

  for (const object of publication.immutableObjects) {
    const publicBytes = await readPublicObject(remote, object.key, object.bytes.length);
    if (
      !publicBytes
      || publicBytes.length !== object.bytes.length
      || sha256(publicBytes) !== object.sha256
    ) {
      throw new Error(`OSS 公开对象 200 大小或 SHA-256 验证失败：${object.key}`);
    }
  }
  events.push("immutable:all-public-200-verified");

  for (const object of publication.immutableObjects) {
    const rangeEnd = Math.min(1023, object.bytes.length - 1);
    const range = await readPublicRange(remote, object.key, 0, rangeEnd);
    const expectedContentRange = `bytes 0-${rangeEnd}/${object.bytes.length}`;
    if (
      range?.status !== 206
      || range.contentRange !== expectedContentRange
      || !Buffer.from(range.bytes ?? []).equals(object.bytes.subarray(0, rangeEnd + 1))
    ) {
      throw new Error(`OSS 公开对象 206 Content-Range 验证失败：${object.key}`);
    }
  }
  events.push("immutable:all-public-206-verified");

  // electron-builder 原始 metadata 逐字提交；失败会立刻停止，绝不推进总指针。
  for (const pointer of publication.metadataPointers) {
    await putAtomic(remote, pointer.key, pointer.bytes, contentMetadata(pointer.key, false));
    await assertRemoteBytes(remote, pointer.key, pointer.bytes);
    events.push(`metadata:${pointer.targetId}`);
  }

  // 每目标平台 latest 在 native metadata 后推进；先批量复核，避免已知漂移下开始写指针。
  for (const pointer of publication.platformCatalogPointers) {
    const current = await readRemoteObject(remote, pointer.key);
    const currentDigest = current ? sha256(current) : null;
    if (currentDigest !== frozenPlatformLatest.get(pointer.key)) {
      throw new Error(`OSS Beta 平台 latest 在事务期间发生变化：${pointer.targetId}`);
    }
  }
  for (const pointer of publication.platformCatalogPointers) {
    await putAtomic(remote, pointer.key, pointer.bytes, contentMetadata(pointer.key, false));
    events.push(`platform-catalog:${pointer.targetId}:latest-published`);
    await assertRemoteBytes(remote, pointer.key, pointer.bytes);
    events.push(`platform-catalog:${pointer.targetId}:latest-verified`);
  }

  // 旧全局 release.json 已在首阶段按不可变对象上传；平台指针完成后再确认并推进 legacy 总指针。
  events.push("catalog:release-uploaded");
  await assertRemoteBytes(remote, publication.releaseKey, publication.releaseBytes);
  events.push("catalog:release-verified");

  // 版本目录和五个平台指针完成后，再比较事务开始时冻结的旧总指针摘要。
  const currentBeforeLatest = await readRemoteObject(remote, latestKey);
  const currentBeforeLatestDigest = currentBeforeLatest ? sha256(currentBeforeLatest) : null;
  if (currentBeforeLatestDigest !== frozenLatestDigest) {
    throw new Error("OSS Beta latest 指针在事务期间发生变化，拒绝推进总指针");
  }
  events.push("catalog:latest-condition-verified");

  await putAtomic(remote, latestKey, publication.latestBytes, contentMetadata(latestKey, false));
  events.push("catalog:latest-published");
  await assertRemoteBytes(remote, latestKey, publication.latestBytes);
  events.push("catalog:latest-verified");

  return { events, version };
}

function loadPublication(root, version) {
  if (!isVersion(version)) throw new Error("发布版本无效");
  if (typeof root !== "string" || root.length === 0) throw new Error("发布事务根目录无效");
  const publicationRoot = path.resolve(root);
  assertDirectory(publicationRoot, "发布事务根目录");
  const bytesByKey = readDesktopTree(publicationRoot);
  const releaseRoot = `desktop/beta/catalog/releases/${version}`;
  const releaseKey = `${releaseRoot}/release.json`;
  const manifestKey = `${releaseRoot}/release-manifest.json`;
  const sumsKey = `${releaseRoot}/SHA256SUMS`;
  const sigstoreKey = `${releaseRoot}/release-manifest.json.sigstore.json`;
  const catalogKeys = [
    releaseKey,
    manifestKey,
    sigstoreKey,
    sumsKey,
  ];

  const releaseBytes = requiredLocalBytes(bytesByKey, releaseKey);
  const latestBytes = requiredLocalBytes(bytesByKey, latestKey);
  const manifestBytes = requiredLocalBytes(bytesByKey, manifestKey);
  const sumsBytes = requiredLocalBytes(bytesByKey, sumsKey);
  const sigstoreBytes = requiredLocalBytes(bytesByKey, sigstoreKey);
  const release = parseJson(releaseBytes, "Beta release catalog");
  const latest = parseJson(latestBytes, "Beta latest catalog");
  const manifest = validateReleaseManifest(parseJson(manifestBytes, "ReleaseManifest"));

  if (
    release.schemaVersion !== 1
    || release.version !== version
    || release.tag !== manifest.tag
    || release.channel !== "beta"
    || release.commitSha !== manifest.commitSha
    || !Array.isArray(release.targets)
    || release.targets.length !== nativeMetadata.length
  ) {
    throw new Error("release.json 必须声明当前 beta 版本和完整五平台");
  }
  if (
    latest.schemaVersion !== 1
    || latest.version !== version
    || latest.channel !== "beta"
    || latest.release !== releaseKey
  ) {
    throw new Error("latest.json 与当前 Beta 版本目录不一致");
  }
  if (manifest.version !== version) throw new Error("ReleaseManifest 与发布版本不一致");

  const artifactKeys = [];
  const metadataPointers = [];
  const platformCatalogPointers = [];
  const platformReleaseKeys = [];
  const expectedManifestArtifacts = [];
  for (const expected of nativeMetadata) {
    const target = release.targets.find((candidate) => candidate?.targetId === expected.targetId);
    if (
      !target
      || target.platform !== expected.platform
      || target.arch !== expected.arch
      || target.nativeMetadata !== expected.key
      || !Array.isArray(target.artifacts)
      || target.artifacts.length === 0
    ) {
      throw new Error(`release.json 五平台条目无效：${expected.targetId}`);
    }
    const metadataBytes = requiredLocalBytes(bytesByKey, expected.key);
    metadataPointers.push({ ...expected, bytes: metadataBytes });
    expectedManifestArtifacts.push({
      path: expected.key,
      fileName: path.posix.basename(expected.key),
      platform: expected.platform,
      arch: expected.arch,
      kind: "metadata",
      size: metadataBytes.length,
      sha256: sha256(metadataBytes),
    });
    const artifactPrefix = `desktop/beta/${expected.platform}/${expected.arch}/`;
    for (const artifact of target.artifacts) {
      const artifactKey = String(artifact?.path ?? "");
      const artifactFileName = String(artifact?.fileName ?? "");
      const artifactKind = String(artifact?.kind ?? "");
      assertBetaObjectKey(artifactKey);
      if (
        !artifactKey.startsWith(artifactPrefix)
        || artifactKey === expected.key
        || path.posix.basename(artifactKey) !== artifactFileName
      ) {
        throw new Error(`release artifact 路径越过目标目录：${artifactKey}`);
      }
      if (artifactKeys.includes(artifactKey)) throw new Error(`release artifact 重复：${artifactKey}`);
      const bytes = requiredLocalBytes(bytesByKey, artifactKey);
      const declaredSize = Number(artifact.size);
      const declaredSha256 = String(artifact.sha256 ?? "").toLowerCase();
      if (
        !Number.isSafeInteger(declaredSize)
        || declaredSize < 1
        || bytes.length !== declaredSize
        || !/^[0-9a-f]{64}$/.test(declaredSha256)
        || sha256(bytes) !== declaredSha256
      ) {
        throw new Error(`release artifact 大小或 SHA-256 无效：${artifactKey}`);
      }
      artifactKeys.push(artifactKey);
      expectedManifestArtifacts.push({
        path: artifactKey,
        fileName: artifactFileName,
        platform: expected.platform,
        arch: expected.arch,
        kind: artifactKind,
        size: declaredSize,
        sha256: declaredSha256,
      });
    }

    const platformRoot = `desktop/beta/${expected.platform}/${expected.arch}`;
    const platformReleaseKey = `${platformRoot}/catalog/releases/${version}/release.json`;
    const platformLatestKey = `${platformRoot}/catalog/latest.json`;
    const platformReleaseBytes = requiredLocalBytes(bytesByKey, platformReleaseKey);
    const platformLatestBytes = requiredLocalBytes(bytesByKey, platformLatestKey);
    const platformRelease = parseJson(platformReleaseBytes, `${expected.targetId} 平台 release catalog`);
    const platformLatest = parseJson(platformLatestBytes, `${expected.targetId} 平台 latest catalog`);
    if (
      platformRelease.schemaVersion !== 2
      || platformRelease.channel !== "beta"
      || platformRelease.sourceChannel !== "beta"
      || platformRelease.platform !== expected.platform
      || platformRelease.arch !== expected.arch
      || platformRelease.version !== version
      || platformRelease.tag !== manifest.tag
      || platformRelease.commitSha !== manifest.commitSha
      || platformRelease.nativeMetadata !== expected.key
      || JSON.stringify(platformRelease.artifacts) !== JSON.stringify(target.artifacts)
    ) {
      throw new Error(`平台 release.json 与全局目标不一致：${expected.targetId}`);
    }
    if (
      platformLatest.schemaVersion !== 2
      || platformLatest.channel !== "beta"
      || platformLatest.platform !== expected.platform
      || platformLatest.arch !== expected.arch
      || platformLatest.version !== version
      || platformLatest.release !== platformReleaseKey
    ) {
      throw new Error(`平台 latest.json 与版本目录不一致：${expected.targetId}`);
    }
    platformReleaseKeys.push(platformReleaseKey);
    platformCatalogPointers.push({ ...expected, key: platformLatestKey, bytes: platformLatestBytes });
  }

  expectedManifestArtifacts.sort((left, right) => compareNames(left.path, right.path));
  if (JSON.stringify(manifest.artifacts) !== JSON.stringify(expectedManifestArtifacts)) {
    throw new Error("ReleaseManifest artifacts 与 release.json、metadata 和普通文件未一一对应");
  }
  const expectedSums = `${manifest.artifacts
    .map((artifact) => `${artifact.sha256}  ${artifact.path}`)
    .join("\n")}\n`;
  if (sumsBytes.toString("utf8") !== expectedSums) {
    throw new Error("SHA256SUMS 与 ReleaseManifest artifacts 不一致");
  }
  validateSigstoreBundle(sigstoreBytes, manifestBytes);

  const expectedKeys = new Set([
    ...artifactKeys,
    ...nativeMetadata.map((item) => item.key),
    ...platformReleaseKeys,
    ...platformCatalogPointers.map((item) => item.key),
    ...catalogKeys,
    latestKey,
  ]);
  for (const key of bytesByKey.keys()) {
    if (!expectedKeys.has(key)) throw new Error(`发布树包含未声明的 Beta 对象：${key}`);
  }
  for (const key of expectedKeys) requiredLocalBytes(bytesByKey, key);

  const immutableObjects = [...artifactKeys, ...platformReleaseKeys, ...catalogKeys]
    .sort(compareNames)
    .map((key) => {
      const bytes = requiredLocalBytes(bytesByKey, key);
      if (bytes.length === 0) throw new Error(`OSS 不可变对象不得为空：${key}`);
      return { key, bytes, sha256: sha256(bytes), metadata: contentMetadata(key, true) };
    });

  return {
    immutableObjects,
    metadataPointers,
    platformCatalogPointers,
    releaseKey,
    releaseBytes,
    latestBytes,
    repository: manifest.repository,
    runId: manifest.runId,
  };
}

/** OSS 只能访问 Beta 前缀；双点也按潜在路径穿越失败关闭。 */
export function assertBetaObjectKey(key) {
  if (typeof key !== "string" || !key.startsWith("desktop/beta/") || key.includes("..")) {
    throw new Error("OSS 对象 Key 越过 Beta 前缀");
  }
}

function readDesktopTree(publicationRoot) {
  const desktopRoot = path.join(publicationRoot, "desktop");
  assertDirectory(desktopRoot, "发布 desktop 目录");
  const bytesByKey = new Map();
  const visit = (directory) => {
    const entries = fs.readdirSync(directory).sort(compareNames);
    for (const entry of entries) {
      const target = path.join(directory, entry);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error("发布普通文件或目录不得为符号链接");
      if (stat.isDirectory()) {
        visit(target);
        continue;
      }
      if (!stat.isFile()) throw new Error("发布普通文件类型无效");
      const key = path.relative(publicationRoot, target).split(path.sep).join("/");
      assertBetaObjectKey(key);
      bytesByKey.set(key, fs.readFileSync(target));
    }
  };
  visit(desktopRoot);
  return bytesByKey;
}

function requiredLocalBytes(bytesByKey, key) {
  assertBetaObjectKey(key);
  const bytes = bytesByKey.get(key);
  if (!bytes) throw new Error(`发布文件缺失或类型无效：${key}`);
  return bytes;
}

function assertDirectory(target, label) {
  if (!fs.existsSync(target)) throw new Error(`${label}缺失或类型无效`);
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}缺失、符号链接或类型无效`);
}

function assertRemoteContract(remote) {
  const methods = [
    "assertImmutableUploadMode",
    "readObject",
    "putImmutable",
    "putAtomic",
    "readPublicObject",
    "readPublicRange",
  ];
  if (!remote || methods.some((name) => typeof remote[name] !== "function")) {
    throw new Error("OSS 远端适配器缺少发布事务能力");
  }
}

async function putImmutable(remote, object) {
  assertBetaObjectKey(object.key);
  const result = await remote.putImmutable(object.key, object.bytes, object.metadata);
  if (result !== "created" && result !== "exists") {
    throw new Error(`OSS 不可变写入结果无效：${object.key}`);
  }
  return result;
}

async function putAtomic(remote, key, bytes, metadata) {
  assertBetaObjectKey(key);
  await remote.putAtomic(key, bytes, metadata);
}

async function readRemoteObject(remote, key) {
  assertBetaObjectKey(key);
  return remote.readObject(key);
}

async function readPublicObject(remote, key, expectedSize) {
  assertBetaObjectKey(key);
  return remote.readPublicObject(key, expectedSize);
}

async function readPublicRange(remote, key, start, end) {
  assertBetaObjectKey(key);
  return remote.readPublicRange(key, start, end);
}

async function assertRemoteBytes(remote, key, expected) {
  const actual = await readRemoteObject(remote, key);
  if (!actual || !Buffer.from(actual).equals(expected)) {
    throw new Error(`OSS 对象逐字回读不一致：${key}`);
  }
}

function assertPublishOrder(currentBytes, candidateBytes, candidateVersion) {
  if (!currentBytes) return;
  const current = parseJson(currentBytes, "远端 Beta latest catalog");
  if (
    current.channel !== "beta"
    || !isVersion(current.version)
    || typeof current.release !== "string"
  ) {
    throw new Error("远端 Beta latest 指针无效");
  }
  assertBetaObjectKey(current.release);
  const comparison = compareVersions(candidateVersion, current.version);
  if (comparison < 0) throw new Error("拒绝把 OSS Beta latest 降级到较旧版本");
  if (comparison === 0 && !Buffer.from(currentBytes).equals(candidateBytes)) {
    throw new Error("同版本 OSS Beta latest 内容冲突");
  }
}

function assertPlatformPublishOrder(currentBytes, candidateBytes, candidateVersion, pointer) {
  const expected = {
    channel: "beta",
    platform: pointer.platform,
    arch: pointer.arch,
  };
  const keys = platformReleaseKeys("beta", pointer.platform, pointer.arch, candidateVersion);
  if (pointer.key !== keys.latest) throw new Error(`平台 latest Key 与目标不一致：${pointer.targetId}`);
  const candidate = parsePlatformLatest(
    parseJson(candidateBytes, `${pointer.targetId} 候选平台 latest`),
    expected,
  );
  if (candidate.version !== candidateVersion) {
    throw new Error(`平台 latest 与候选版本不一致：${pointer.targetId}`);
  }
  if (!currentBytes) return;
  const current = parsePlatformLatest(
    parseJson(currentBytes, `${pointer.targetId} 远端平台 latest`),
    expected,
  );
  const comparison = compareDesktopVersions(candidateVersion, current.version);
  if (comparison < 0) throw new Error(`拒绝把 OSS Beta 平台 latest 降级到较旧版本：${pointer.targetId}`);
  if (comparison === 0 && !Buffer.from(currentBytes).equals(candidateBytes)) {
    throw new Error(`同版本 OSS Beta 平台 latest 内容冲突：${pointer.targetId}`);
  }
}

function compareVersions(left, right) {
  const parse = (value) => {
    const [main, prerelease = ""] = value.split("-", 2);
    return { numbers: main.split(".").map(Number), prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}

function contentMetadata(key, immutable) {
  const contentType = key.endsWith(".json")
    ? "application/json; charset=utf-8"
    : key.endsWith(".yml")
      ? "text/yaml; charset=utf-8"
      : key.endsWith("SHA256SUMS")
        ? "text/plain; charset=utf-8"
        : "application/octet-stream";
  return {
    contentType,
    cacheControl: immutable ? "public, max-age=31536000, immutable" : "no-cache",
  };
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`${label} 不是有效 JSON`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateSigstoreBundle(bytes, manifestBytes) {
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
    throw new Error("Sigstore bundle 结构无效");
  }
  const digest = crypto.createHash("sha256").update(manifestBytes).digest("base64");
  if (bundle.messageSignature.messageDigest.digest !== digest) {
    throw new Error("Sigstore bundle 与 ReleaseManifest digest 不一致");
  }
}

function isVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function contentMd5(bytes) {
  return crypto.createHash("md5").update(bytes).digest("base64");
}

function compareNames(left, right) {
  return left.localeCompare(right, "en");
}

/** 正式适配器只读取外部既有配置；不会创建或修改 Bucket、RAM、AK、角色或权限。 */
export async function createAliyunOssRemoteFromEnvironment(environment = process.env, dependencies = {}) {
  const required = [
    "OSS_ACCESS_KEY_ID",
    "OSS_ACCESS_KEY_SECRET",
    "OSS_REGION",
    "OSS_BUCKET",
    "OSS_ENDPOINT",
    "TIANJIANG_RELEASE_PUBLIC_BASE_URL",
  ];
  const missing = required.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) throw new Error(`OSS 发布配置缺失：${missing.join(", ")}`);
  if (environment.OSS_REGION.trim() !== OSS_REGION) {
    throw new Error("OSS Region 配置不符合固定发布边界");
  }
  if (environment.OSS_ENDPOINT.trim() !== OSS_ENDPOINT) {
    throw new Error("OSS Endpoint 配置不符合固定发布边界");
  }

  let publicBase;
  try {
    publicBase = new URL(environment.TIANJIANG_RELEASE_PUBLIC_BASE_URL);
  } catch {
    throw new Error("OSS 公开下载地址配置无效");
  }
  if (publicBase.protocol !== "https:") throw new Error("OSS 公开下载地址必须使用 HTTPS");

  // Region/Endpoint 硬门通过后才加载 SDK；依赖注入仅用于仓库内离线成功链测试。
  const loadOss = dependencies.loadOss ?? (() => import("ali-oss"));
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  if (typeof loadOss !== "function" || typeof fetchImplementation !== "function") {
    throw new Error("OSS 离线依赖配置无效");
  }
  const imported = await loadOss();
  const OSS = imported.default ?? imported;
  const client = new OSS({
    region: environment.OSS_REGION.trim(),
    endpoint: OSS_ENDPOINT,
    bucket: environment.OSS_BUCKET.trim(),
    accessKeyId: environment.OSS_ACCESS_KEY_ID.trim(),
    accessKeySecret: environment.OSS_ACCESS_KEY_SECRET.trim(),
    authorizationV4: true,
    secure: true,
  });
  const headersFor = (bytes, metadata, immutable) => ({
    "Content-MD5": contentMd5(bytes),
    "Content-Type": metadata.contentType,
    "Cache-Control": metadata.cacheControl,
    ...(immutable ? { "x-oss-forbid-overwrite": "true" } : {}),
  });
  const publicURL = (key) => {
    assertBetaObjectKey(key);
    return new URL(key.split("/").map(encodeURIComponent).join("/"), publicBase).href;
  };

  return {
    async assertImmutableUploadMode() {
      try {
        const result = await client.getBucketVersioning(environment.OSS_BUCKET.trim());
        assertUnversionedBucketStatus(result?.versionStatus);
      } catch (error) {
        if (error instanceof Error && /版本控制/.test(error.message)) throw error;
        throw sanitizedRemoteError(error);
      }
    },
    async readObject(key) {
      assertBetaObjectKey(key);
      try {
        const result = await client.get(key);
        return Buffer.from(result.content);
      } catch (error) {
        if (error?.status === 404 || error?.code === "NoSuchKey") return null;
        throw sanitizedRemoteError(error);
      }
    },
    async putImmutable(key, bytes, metadata) {
      assertBetaObjectKey(key);
      try {
        await client.put(key, bytes, { headers: headersFor(bytes, metadata, true) });
        return "created";
      } catch (error) {
        if (error?.status === 409 || error?.code === "FileAlreadyExists") return "exists";
        throw sanitizedRemoteError(error);
      }
    },
    async putAtomic(key, bytes, metadata) {
      assertBetaObjectKey(key);
      try {
        await client.put(key, bytes, { headers: headersFor(bytes, metadata, false) });
      } catch (error) {
        throw sanitizedRemoteError(error);
      }
    },
    async readPublicObject(key, expectedSize) {
      let response;
      try {
        response = await fetchImplementation(publicURL(key), { cache: "no-store" });
      } catch (error) {
        throw sanitizedRemoteError(error);
      }
      if (response.status !== 200) throw new Error(`OSS 公开对象回读失败，HTTP ${response.status}`);
      const declaredSize = Number(response.headers.get("content-length") ?? "0");
      if (declaredSize > 0 && declaredSize !== expectedSize) {
        throw new Error("OSS 公开对象 Content-Length 与本地对象不一致");
      }
      const chunks = [];
      let total = 0;
      try {
        for await (const chunk of response.body ?? []) {
          const bytes = Buffer.from(chunk);
          total += bytes.length;
          if (total > expectedSize) throw new Error("OSS 公开对象大小超过本地对象");
          chunks.push(bytes);
        }
      } catch (error) {
        if (error instanceof Error && error.message === "OSS 公开对象大小超过本地对象") throw error;
        throw sanitizedRemoteError(error);
      }
      return Buffer.concat(chunks, total);
    },
    async readPublicRange(key, start, end) {
      let response;
      try {
        response = await fetchImplementation(publicURL(key), {
          cache: "no-store",
          headers: {
            Range: `bytes=${start}-${end}`,
            "x-oss-range-behavior": "standard",
          },
        });
        return {
          status: response.status,
          contentRange: response.headers.get("content-range"),
          bytes: Buffer.from(await response.arrayBuffer()),
        };
      } catch (error) {
        throw sanitizedRemoteError(error);
      }
    },
  };
}

/**
 * forbid-overwrite 只在未启用版本控制的 Bucket 中提供不可覆盖语义。
 * 未配置版本控制时 OSS 响应不含 Status；其余状态都按未知风险失败关闭。
 */
export function assertUnversionedBucketStatus(versionStatus) {
  if (versionStatus === undefined || versionStatus === null || versionStatus === "") return;
  if (versionStatus === "Enabled" || versionStatus === "Suspended") {
    throw new Error("OSS Bucket 已启用或暂停版本控制，禁止执行不可覆盖发布");
  }
  throw new Error("OSS Bucket 版本控制状态无法确认，禁止远端发布");
}

function sanitizedRemoteError(error) {
  const status = typeof error?.status === "number" ? `，HTTP ${error.status}` : "";
  const code = typeof error?.code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(error.code)
    ? `，代码 ${error.code}`
    : "";
  return new Error(`OSS 远端操作失败${status}${code}；未输出配置值、凭据或响应正文`);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  void runCli().catch((error) => {
    process.stderr.write(`[远端发布事务] ${safeCliError(error)}\n`);
    process.exitCode = 1;
  });
}

function safeCliError(error) {
  const message = error instanceof Error ? error.message : "未知错误";
  if (/^(?:用法:|OSS 发布配置缺失|OSS Region|OSS Endpoint|OSS 公开下载地址)/.test(message)) {
    return message;
  }
  const status = typeof error?.status === "number" ? `，HTTP ${error.status}` : "";
  const code = typeof error?.code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(error.code)
    ? `，代码 ${error.code}`
    : "";
  return `远端阶段失败${status}${code}；未输出配置值、凭据或响应正文`;
}

async function runCli() {
  const [publicationRoot, version] = process.argv.slice(2);
  if (!publicationRoot || !version) {
    throw new Error("用法: node publish-release-transaction.mjs <publicationRoot> <version>");
  }
  const remote = await createAliyunOssRemoteFromEnvironment();
  const result = await publishReleaseTransaction({
    publicationRoot,
    version,
    remote,
    singleWriterProof: process.env.TIANJIANG_RELEASE_SINGLE_WRITER,
  });
  // 只输出公开版本与固定阶段名，不输出 endpoint、Bucket、AK 或响应正文。
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

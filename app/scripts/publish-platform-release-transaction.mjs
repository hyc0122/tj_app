import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateStableSourcePlatformReleaseManifest } from "./build-release-manifest.mjs";
import {
  compareDesktopVersions,
  parsePlatformLatest,
  parsePlatformRelease,
  platformReleaseKeys,
} from "./platform-release-contract.mjs";

const CHANNELS = ["stable", "beta"];
// Windows 安装包接近 300 MiB，显式覆盖 ali-oss 默认 60 秒请求超时。
const OSS_RELEASE_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

function fail(reason) {
  throw new Error(`Stable Windows 远端发布失败：${reason}`);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function parseJson(bytes, label) {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(`${label}必须是 JSON 对象`);
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Stable Windows 远端发布失败")) throw error;
    fail(`${label}不是有效 JSON`);
  }
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

function contentMd5(bytes) {
  return crypto.createHash("md5").update(bytes).digest("base64");
}

function assertPlatformKey(key) {
  if (
    typeof key !== "string"
    || key.includes("..")
    || !/^desktop\/(?:stable|beta)\/windows\/x64\//.test(key)
  ) {
    fail("对象 Key 越过 Stable/Beta Windows x64 边界");
  }
}

function readPublicationTree(root) {
  const bytesByKey = new Map();
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory).sort((left, right) => left.localeCompare(right, "en"))) {
      const target = path.join(directory, entry);
      const details = fs.lstatSync(target);
      if (details.isSymbolicLink()) fail("发布树不得包含符号链接");
      if (details.isDirectory()) {
        visit(target);
      } else if (details.isFile()) {
        const key = path.relative(root, target).split(path.sep).join("/");
        assertPlatformKey(key);
        bytesByKey.set(key, fs.readFileSync(target));
      } else {
        fail("发布树包含无效文件类型");
      }
    }
  };
  visit(root);
  return bytesByKey;
}

function requiredBytes(bytesByKey, key) {
  assertPlatformKey(key);
  const bytes = bytesByKey.get(key);
  if (!bytes || bytes.length === 0) fail(`发布对象缺失或为空：${key}`);
  return bytes;
}

function validateSigstore(bundleBytes, manifestBytes) {
  const bundle = parseJson(bundleBytes, "Sigstore bundle");
  if (
    bundle.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json"
    || !bundle.verificationMaterial
    || typeof bundle.verificationMaterial !== "object"
    || !bundle.messageSignature
    || typeof bundle.messageSignature !== "object"
    || bundle.messageSignature?.messageDigest?.algorithm !== "SHA2_256"
    || typeof bundle.messageSignature.messageDigest.digest !== "string"
    || typeof bundle.messageSignature.signature !== "string"
    || bundle.messageSignature.signature.length === 0
  ) {
    fail("Sigstore bundle 结构无效");
  }
  const digest = crypto.createHash("sha256").update(manifestBytes).digest("base64");
  if (bundle.messageSignature.messageDigest.digest !== digest) fail("Sigstore bundle 公开摘要不一致");
}

function validateSourceProof(manifestBytes, sumsBytes, sigstoreBytes, version, channelPublication) {
  const { channel } = channelPublication;
  const manifest = validateStableSourcePlatformReleaseManifest(
    parseJson(manifestBytes, `${channel} ReleaseManifest`),
    channel,
  );
  if (manifest.version !== version) fail("Stable ReleaseManifest 与发布版本不一致");
  const metadataArtifact = {
    path: channelPublication.metadataKey,
    fileName: path.posix.basename(channelPublication.metadataKey),
    platform: "windows",
    arch: "x64",
    kind: "metadata",
    size: channelPublication.metadataBytes.length,
    sha256: sha256(channelPublication.metadataBytes),
  };
  const expectedArtifacts = [
    ...channelPublication.release.artifacts.map((artifact) => ({
      path: artifact.path,
      fileName: artifact.fileName,
      platform: "windows",
      arch: "x64",
      kind: artifact.kind,
      size: artifact.size,
      sha256: artifact.sha256,
    })),
    metadataArtifact,
  ].sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (JSON.stringify(manifest.artifacts) !== JSON.stringify(expectedArtifacts)) {
    fail(`${channel} ReleaseManifest 与发布普通文件未一一对应`);
  }
  const expectedSums = `${manifest.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n")}\n`;
  if (Buffer.from(sumsBytes).toString("utf8") !== expectedSums) fail(`SHA256SUMS 与 ${channel} ReleaseManifest 不一致`);
  validateSigstore(sigstoreBytes, manifestBytes);
  return manifest;
}

function loadChannel(bytesByKey, channel, version) {
  const keys = platformReleaseKeys(channel, "windows", "x64", version);
  const releaseBytes = requiredBytes(bytesByKey, keys.release);
  const latestBytes = requiredBytes(bytesByKey, keys.latest);
  const metadataBytes = requiredBytes(bytesByKey, keys.nativeMetadata);
  const release = parsePlatformRelease(parseJson(releaseBytes, `${channel} release.json`), {
    channel,
    platform: "windows",
    arch: "x64",
  });
  const latest = parsePlatformLatest(parseJson(latestBytes, `${channel} latest.json`), {
    channel,
    platform: "windows",
    arch: "x64",
  });
  if (release.version !== version || latest.version !== version || latest.release !== keys.release) {
    fail(`${channel} 发布记录或指针版本不一致`);
  }
  if (release.sourceChannel !== "stable") fail(`${channel} 只允许 Stable 来源`);
  const prefix = path.posix.dirname(keys.nativeMetadata);
  const artifacts = release.artifacts.map((artifact) => {
    if (artifact.path !== `${prefix}/${artifact.fileName}`) fail(`${channel} artifact 路径越界`);
    const bytes = requiredBytes(bytesByKey, artifact.path);
    if (bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256) {
      fail(`${channel} artifact 大小或 SHA-256 不一致`);
    }
    return { key: artifact.path, bytes, sha256: artifact.sha256 };
  });
  if (
    artifacts.length !== 2
    || release.artifacts.filter((artifact) => artifact.kind === "installer").length !== 1
    || release.artifacts.filter((artifact) => artifact.kind === "blockmap").length !== 1
  ) {
    fail(`${channel} Windows 发布必须同时包含 installer 与 blockmap`);
  }
  const releaseRoot = path.posix.dirname(keys.release);
  const manifestKey = `${releaseRoot}/release-manifest.json`;
  const sumsKey = `${releaseRoot}/SHA256SUMS`;
  const sigstoreKey = `${releaseRoot}/release-manifest.json.sigstore.json`;
  const proofObjects = [
    { key: keys.release, bytes: releaseBytes },
    { key: manifestKey, bytes: requiredBytes(bytesByKey, manifestKey) },
    { key: sumsKey, bytes: requiredBytes(bytesByKey, sumsKey) },
    { key: sigstoreKey, bytes: requiredBytes(bytesByKey, sigstoreKey) },
  ];
  return {
    channel,
    keys,
    release,
    releaseBytes,
    latestBytes,
    metadataKey: keys.nativeMetadata,
    metadataBytes,
    manifestBytes: proofObjects[1].bytes,
    sumsBytes: proofObjects[2].bytes,
    sigstoreBytes: proofObjects[3].bytes,
    immutableObjects: [...artifacts, ...proofObjects]
      .sort((left, right) => left.key.localeCompare(right.key, "en"))
      .map((object) => ({
        ...object,
        sha256: sha256(object.bytes),
        metadata: contentMetadata(object.key, true),
      })),
  };
}

function loadPublication(publicationRoot, version) {
  if (typeof publicationRoot !== "string" || publicationRoot.length === 0) fail("发布根无效");
  const root = path.resolve(publicationRoot);
  if (!fs.existsSync(root)) fail("发布根不存在");
  const details = fs.lstatSync(root);
  if (!details.isDirectory() || details.isSymbolicLink()) fail("发布根必须是非符号链接目录");
  const bytesByKey = readPublicationTree(root);
  const publications = Object.fromEntries(CHANNELS.map((channel) => [channel, loadChannel(bytesByKey, channel, version)]));
  const stable = publications.stable;
  const beta = publications.beta;
  const stableManifest = validateSourceProof(stable.manifestBytes, stable.sumsBytes, stable.sigstoreBytes, version, stable);
  const betaManifest = validateSourceProof(beta.manifestBytes, beta.sumsBytes, beta.sigstoreBytes, version, beta);
  if (
    beta.manifestBytes.equals(stable.manifestBytes)
    || beta.sumsBytes.equals(stable.sumsBytes)
    || beta.sigstoreBytes.equals(stable.sigstoreBytes)
  ) {
    fail("Beta 兼容树必须使用独立通道来源证明");
  }
  for (const field of ["version", "tag", "commitSha", "repository", "workflow", "runId", "runAttempt", "generatedAt"]) {
    if (stableManifest[field] !== betaManifest[field]) fail(`Stable/Beta 来源字段不一致：${field}`);
  }
  const stableArtifacts = stable.release.artifacts.map(({ fileName, kind, size, sha256: digest }) => ({ fileName, kind, size, sha256: digest }));
  const betaArtifacts = beta.release.artifacts.map(({ fileName, kind, size, sha256: digest }) => ({ fileName, kind, size, sha256: digest }));
  if (JSON.stringify(betaArtifacts) !== JSON.stringify(stableArtifacts) || !beta.metadataBytes.equals(stable.metadataBytes)) {
    fail("Beta 兼容树与 Stable Windows 内容不一致");
  }
  const expectedKeys = new Set(CHANNELS.flatMap((channel) => [
    publications[channel].keys.latest,
    publications[channel].metadataKey,
    ...publications[channel].immutableObjects.map((object) => object.key),
  ]));
  for (const key of bytesByKey.keys()) {
    if (!expectedKeys.has(key)) fail(`发布树包含其他平台或未声明对象：${key}`);
  }
  return { publications, repository: stableManifest.repository, runId: stableManifest.runId };
}

function assertRemoteContract(remote) {
  const methods = [
    "assertImmutableUploadMode",
    "readObject",
    "readMutable",
    "putImmutable",
    "putAtomic",
    "readPublicObject",
    "readPublicRange",
  ];
  if (!remote || methods.some((name) => typeof remote[name] !== "function")) fail("远端适配器缺少发布事务能力");
}

async function remoteBytes(remote, key) {
  assertPlatformKey(key);
  return remote.readObject(key);
}

async function readMutable(remote, key) {
  assertPlatformKey(key);
  const state = await remote.readMutable(key);
  if (
    !state
    || typeof state !== "object"
    || (state.bytes !== null && !Buffer.isBuffer(state.bytes) && !(state.bytes instanceof Uint8Array))
  ) {
    fail(`远端可变对象状态无效：${key}`);
  }
  return {
    bytes: state.bytes === null ? null : Buffer.from(state.bytes),
  };
}

function assertPointerOrder(currentBytes, candidateBytes, candidateVersion, channel) {
  if (!currentBytes) return null;
  const current = parsePlatformLatest(parseJson(currentBytes, `远端 ${channel} latest.json`), {
    channel,
    platform: "windows",
    arch: "x64",
  });
  const comparison = compareDesktopVersions(candidateVersion, current.version);
  if (comparison < 0 && channel === "stable") fail("拒绝 Stable 平台指针版本倒退到较旧版本");
  if (comparison === 0 && !Buffer.from(currentBytes).equals(candidateBytes)) {
    fail(`同版本 ${channel} 平台指针内容冲突`);
  }
  return current;
}

function metadataVersion(bytes, channel) {
  const match = /^version:\s*([^\s#]+)\s*$/m.exec(Buffer.from(bytes).toString("utf8"));
  if (!match) fail(`远端 ${channel} native metadata 缺少有效 version`);
  // 复用平台合同的版本比较器执行语法验证，不维护第二套 SemVer 解析。
  compareDesktopVersions(match[1], match[1]);
  return match[1];
}

function assertMetadataOrder(currentState, candidateBytes, candidateVersion, channel) {
  if (currentState.bytes === null) return;
  const currentVersion = metadataVersion(currentState.bytes, channel);
  const comparison = compareDesktopVersions(candidateVersion, currentVersion);
  if (comparison < 0) fail(`拒绝 ${channel} native metadata 版本倒退到较旧版本`);
  if (comparison === 0 && !currentState.bytes.equals(candidateBytes)) {
    fail(`${channel} native metadata 同版本内容冲突`);
  }
}

function assertMetadataIdentity(currentState, candidateBytes, channel) {
  if (currentState.bytes === null) fail(`${channel} native metadata 缺失，无法验证同版本完整身份`);
  if (!currentState.bytes.equals(candidateBytes)) {
    fail(`${channel} native metadata 同版本内容冲突，只验证身份必须逐字一致`);
  }
}

function sameFrozenState(current, frozen) {
  return current.bytes === null
    ? frozen.bytes === null
    : frozen.bytes !== null && current.bytes.equals(frozen.bytes);
}

async function putAtomicAfterFrozenReadback(remote, key, bytes, metadata, frozenState) {
  assertPlatformKey(key);
  const beforeWrite = await readMutable(remote, key);
  if (!sameFrozenState(beforeWrite, frozenState)) fail(`可变对象写前发生漂移，拒绝覆盖：${key}`);

  // 普通 PutObject 不支持目标对象 CAS。单写者门与紧邻写前复核覆盖受控工作流；
  // 任意外部写者仍可能在本次读取与原子 PutObject 之间竞争，这是无法消除的显式风险窗口。
  await remote.putAtomic(key, bytes, metadata);
  const readback = await readMutable(remote, key);
  if (readback.bytes === null || !readback.bytes.equals(bytes)) fail(`原子 PutObject 逐字回读失败：${key}`);
}

async function uploadImmutable(remote, objects) {
  for (const object of objects) {
    // 恢复发布时先验证手工补齐或上次成功写入的对象，避免再次发送大文件 PUT 触发 EPIPE。
    const existingBeforePut = await remoteBytes(remote, object.key);
    if (existingBeforePut) {
      if (!Buffer.from(existingBeforePut).equals(object.bytes)) fail(`不可变对象内容冲突：${object.key}`);
      continue;
    }
    const result = await remote.putImmutable(object.key, object.bytes, object.metadata);
    if (result !== "created" && result !== "exists") fail(`不可变写入结果无效：${object.key}`);
    if (result === "exists") {
      const existing = await remoteBytes(remote, object.key);
      if (!existing || !Buffer.from(existing).equals(object.bytes)) fail(`不可变对象内容冲突：${object.key}`);
    }
  }
}

async function verifyExistingImmutable(remote, objects) {
  for (const object of objects) {
    const existing = await remoteBytes(remote, object.key);
    if (!existing) fail(`只验证的不可变对象缺失：${object.key}`);
    if (!Buffer.from(existing).equals(object.bytes)) fail(`不可变对象内容冲突：${object.key}`);
  }
}

async function verifyPublicObjects(remote, objects) {
  for (const object of objects) {
    const summary = await remote.readPublicObject(object.key, object.bytes.length, object.sha256);
    if (summary?.size !== object.bytes.length || summary.sha256 !== object.sha256) {
      fail(`公开对象 200 大小或 SHA-256 摘要验证失败：${object.key}`);
    }
  }
  for (const object of objects) {
    const end = Math.min(1023, object.bytes.length - 1);
    const range = await remote.readPublicRange(object.key, 0, end);
    if (
      range?.status !== 206
      || range.contentRange !== `bytes 0-${end}/${object.bytes.length}`
      || !Buffer.from(range.bytes ?? []).equals(object.bytes.subarray(0, end + 1))
    ) {
      fail(`公开对象 206 Content-Range 验证失败：${object.key}`);
    }
  }
}

/**
 * 先冻结双平台指针，再验证全部不可变对象与公开下载，最后才推进平台 latest。
 */
export async function publishStableWindowsTransaction(options) {
  const { publicationRoot, version, remote, singleWriterProof } = options ?? {};
  const publication = loadPublication(publicationRoot, version);
  const expectedProof = `github-actions:${publication.repository}:${publication.runId}:stable:windows-x64`;
  if (singleWriterProof !== expectedProof) fail("GitHub Actions 单写者证明不匹配");
  assertRemoteContract(remote);

  const frozen = {};
  for (const channel of CHANNELS) {
    const candidate = publication.publications[channel];
    const latest = await readMutable(remote, candidate.keys.latest);
    const metadata = await readMutable(remote, candidate.metadataKey);
    const current = assertPointerOrder(latest.bytes, candidate.latestBytes, version, channel);
    frozen[channel] = { latest, metadata, current };
  }
  // forbid-overwrite 语义检查在任何上传前完成；冻结发生在检查之前以覆盖检查阶段并发。
  await remote.assertImmutableUploadMode();

  const betaCurrent = frozen.beta.current;
  const betaComparison = betaCurrent ? compareDesktopVersions(version, betaCurrent.version) : 1;
  const promoteBeta = !betaCurrent || betaComparison > 0;
  const channels = promoteBeta ? ["stable", "beta"] : ["stable"];
  const selected = channels.map((channel) => publication.publications[channel]);
  // Beta 同版本不推进，但必须逐字验证完整身份，禁止仅凭 latest.json 判定幂等。
  const verifyOnly = betaComparison === 0 ? [publication.publications.beta] : [];
  const validated = [...selected, ...verifyOnly];
  for (const item of selected) {
    assertMetadataOrder(frozen[item.channel].metadata, item.metadataBytes, version, item.channel);
  }
  for (const item of verifyOnly) {
    assertMetadataIdentity(frozen[item.channel].metadata, item.metadataBytes, item.channel);
  }
  const immutableObjects = selected.flatMap((item) => item.immutableObjects);
  const verifyOnlyImmutableObjects = verifyOnly.flatMap((item) => item.immutableObjects);

  await uploadImmutable(remote, immutableObjects);
  await verifyExistingImmutable(remote, verifyOnlyImmutableObjects);
  await verifyPublicObjects(remote, [...immutableObjects, ...verifyOnlyImmutableObjects]);

  // 实际推进与只验证通道都要复核冻结身份，避免验证期间的漂移被遗漏。
  for (const item of validated) {
    const channel = item.channel;
    const currentLatest = await readMutable(remote, item.keys.latest);
    const currentMetadata = await readMutable(remote, item.metadataKey);
    if (!sameFrozenState(currentLatest, frozen[channel].latest)) fail(`${channel} 平台 latest 在事务期间发生变化`);
    if (!sameFrozenState(currentMetadata, frozen[channel].metadata)) fail(`${channel} native metadata 在事务期间发生变化`);
  }

  for (const item of selected) {
    await putAtomicAfterFrozenReadback(
      remote,
      item.metadataKey,
      item.metadataBytes,
      contentMetadata(item.metadataKey, false),
      frozen[item.channel].metadata,
    );
  }

  for (const item of selected) {
    await putAtomicAfterFrozenReadback(
      remote,
      item.keys.latest,
      item.latestBytes,
      contentMetadata(item.keys.latest, false),
      frozen[item.channel].latest,
    );
  }
  return { version, channels };
}

async function readBoundedHttpBody(response, expectedSize, { expectedSha256 = null, collect = false } = {}) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1) fail("公开响应预期大小无效");
  const declared = response.headers?.get?.("content-length");
  if (typeof declared !== "string" || !/^\d+$/.test(declared) || Number(declared) !== expectedSize) {
    fail("OSS 公开对象 Content-Length 与本地对象不一致");
  }
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== "function") {
    fail("OSS 公开对象响应体不可流式读取");
  }
  const hash = crypto.createHash("sha256");
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > expectedSize) fail("OSS 公开对象累计字节超过本地对象");
    hash.update(bytes);
    if (collect) chunks.push(bytes);
  }
  if (total !== expectedSize) fail("OSS 公开对象累计字节与本地对象不一致");
  const digest = hash.digest("hex");
  if (expectedSha256 !== null && digest !== expectedSha256) fail("OSS 公开对象 SHA-256 摘要不一致");
  return {
    size: total,
    sha256: digest,
    ...(collect ? { bytes: Buffer.concat(chunks, total) } : {}),
  };
}

/** 正式适配器只消费既有 OSS 配置；不会建桶、删对象或修改权限。 */
export async function createPlatformOssRemoteFromEnvironment(environment = process.env, dependencies = {}) {
  const required = [
    "OSS_ACCESS_KEY_ID",
    "OSS_ACCESS_KEY_SECRET",
    "OSS_REGION",
    "OSS_BUCKET",
    "OSS_ENDPOINT",
    "TIANJIANG_RELEASE_PUBLIC_BASE_URL",
  ];
  const missing = required.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) fail(`OSS 发布配置缺失：${missing.join(", ")}`);
  if (environment.OSS_REGION.trim() !== "oss-cn-qingdao") fail("OSS Region 配置不符合固定发布边界");
  if (environment.OSS_ENDPOINT.trim() !== "https://oss-cn-qingdao.aliyuncs.com") {
    fail("OSS Endpoint 配置不符合固定发布边界");
  }
  let publicBase;
  try {
    publicBase = new URL(environment.TIANJIANG_RELEASE_PUBLIC_BASE_URL);
  } catch {
    fail("OSS 公开下载地址配置无效");
  }
  if (publicBase.protocol !== "https:") fail("OSS 公开下载地址必须使用 HTTPS");

  // 固定 Region/Endpoint 通过后才加载 SDK；注入点仅供仓库离线测试。
  const loadOss = dependencies.loadOss ?? (() => import("ali-oss"));
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  if (typeof loadOss !== "function" || typeof fetchImplementation !== "function") fail("OSS 依赖配置无效");
  const imported = await loadOss();
  const OSS = imported.default ?? imported;
  const client = new OSS({
    region: "oss-cn-qingdao",
    endpoint: "https://oss-cn-qingdao.aliyuncs.com",
    bucket: environment.OSS_BUCKET.trim(),
    accessKeyId: environment.OSS_ACCESS_KEY_ID.trim(),
    accessKeySecret: environment.OSS_ACCESS_KEY_SECRET.trim(),
    authorizationV4: true,
    secure: true,
    timeout: OSS_RELEASE_REQUEST_TIMEOUT_MS,
  });
  const headersFor = (bytes, metadata, immutable) => ({
    "Content-MD5": contentMd5(bytes),
    "Content-Type": metadata.contentType,
    "Cache-Control": metadata.cacheControl,
    ...(immutable ? { "x-oss-forbid-overwrite": "true" } : {}),
  });
  const publicUrl = (key) => {
    assertPlatformKey(key);
    return new URL(key.split("/").map(encodeURIComponent).join("/"), publicBase).href;
  };
  const sanitize = (error) => {
    const status = typeof error?.status === "number" ? `，HTTP ${error.status}` : "";
    const code = typeof error?.code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(error.code)
      ? `，代码 ${error.code}`
      : "";
    return new Error(`OSS 远端操作失败${status}${code}；未输出配置值、凭据或响应正文`);
  };

  return {
    async assertImmutableUploadMode() {
      try {
        const result = await client.getBucketVersioning(environment.OSS_BUCKET.trim());
        const status = result?.versionStatus;
        if (status !== undefined && status !== null && status !== "") {
          fail("OSS Bucket 版本控制状态不允许不可覆盖发布");
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Stable Windows 远端发布失败")) throw error;
        throw sanitize(error);
      }
    },
    async readObject(key) {
      assertPlatformKey(key);
      try {
        const result = await client.get(key);
        return Buffer.from(result.content);
      } catch (error) {
        if (error?.status === 404 || error?.code === "NoSuchKey") return null;
        throw sanitize(error);
      }
    },
    async readMutable(key) {
      assertPlatformKey(key);
      try {
        const result = await client.get(key);
        return { bytes: Buffer.from(result.content) };
      } catch (error) {
        if (error?.status === 404 || error?.code === "NoSuchKey") {
          return { bytes: null };
        }
        if (error instanceof Error && error.message.startsWith("Stable Windows 远端发布失败")) throw error;
        throw sanitize(error);
      }
    },
    async putImmutable(key, bytes, metadata) {
      assertPlatformKey(key);
      try {
        await client.put(key, bytes, { headers: headersFor(bytes, metadata, true) });
        return "created";
      } catch (error) {
        if (error?.status === 409 || error?.code === "FileAlreadyExists") return "exists";
        throw sanitize(error);
      }
    },
    async putAtomic(key, bytes, metadata) {
      assertPlatformKey(key);
      try {
        // OSS 单次 PutObject 是原子替换，但普通 PutObject 不支持 If-Match/If-None-Match。
        await client.put(key, bytes, { headers: headersFor(bytes, metadata, false) });
      } catch (error) {
        throw sanitize(error);
      }
    },
    async readPublicObject(key, expectedSize, expectedSha256) {
      let response;
      try {
        response = await fetchImplementation(publicUrl(key), { cache: "no-store" });
      } catch (error) {
        throw sanitize(error);
      }
      if (response.status !== 200) fail(`OSS 公开对象回读失败，HTTP ${response.status}`);
      return readBoundedHttpBody(response, expectedSize, { expectedSha256 });
    },
    async readPublicRange(key, start, end) {
      let response;
      try {
        response = await fetchImplementation(publicUrl(key), {
          cache: "no-store",
          headers: { Range: `bytes=${start}-${end}`, "x-oss-range-behavior": "standard" },
        });
      } catch (error) {
        throw sanitize(error);
      }
      const expectedSize = end - start + 1;
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > 1024) {
        fail("OSS Range 校验长度必须在 1..1024 字节内");
      }
      const body = await readBoundedHttpBody(response, expectedSize, { collect: true });
      return {
        status: response.status,
        contentRange: response.headers.get("content-range"),
        bytes: body.bytes,
      };
    },
  };
}

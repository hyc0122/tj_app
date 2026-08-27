const DESKTOP_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;
const CHANNELS = new Set(["stable", "beta"]);
const BETA_TARGETS = new Map([
  ["windows-x64", "latest.yml"],
  ["macos-x64", "latest-mac.yml"],
  ["macos-arm64", "latest-mac.yml"],
  ["linux-x64", "latest-linux.yml"],
  ["linux-arm64", "latest-linux.yml"],
]);

function fail(message) {
  throw new Error(`平台发布合同：${message}`);
}

function parseVersion(value) {
  if (typeof value !== "string") fail("版本必须是字符串");
  const match = DESKTOP_VERSION.exec(value);
  if (!match) fail(`版本无效：${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    beta: match[4] === undefined ? null : Number(match[4]),
  };
}

function assertChannel(channel) {
  if (!CHANNELS.has(channel)) fail(`渠道无效：${channel}`);
}

function assertTarget(channel, platform, arch) {
  assertChannel(channel);
  const targetId = `${platform}-${arch}`;
  if (!BETA_TARGETS.has(targetId)) fail("平台或架构不在桌面发布目标内");
  // Stable 与 Beta 共用云端三平台目标；兼容晋升仍在 release 来源校验中单独限制。
  return targetId;
}

function assertVersionForChannel(version, channel, sourceChannel = channel) {
  const parsed = parseVersion(version);
  // Stable 只能指向正式版；Beta 可指向原生 Beta 或稳定兼容晋升。
  if (channel === "stable" && parsed.beta !== null) fail("stable 只接受正式版");
  if (sourceChannel === "beta" && parsed.beta === null) fail("Beta 原生来源只接受 Beta 版本");
  if (sourceChannel === "stable" && parsed.beta !== null) fail("Stable 来源只接受正式版");
  return parsed;
}

function assertExpected(expected) {
  if (!expected || typeof expected !== "object") fail("expected 缺失");
  assertTarget(expected.channel, expected.platform, expected.arch);
}

/** 比较桌面合同版本；正式版高于同主版本预发布，beta.N 按数字排序。 */
export function compareDesktopVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.beta === b.beta) return 0;
  if (a.beta === null) return 1;
  if (b.beta === null) return -1;
  return a.beta > b.beta ? 1 : -1;
}

/** 返回平台目录固定键，防止跨通道和路径前缀碰撞。 */
export function platformReleaseKeys(channel, platform, arch, version) {
  const targetId = assertTarget(channel, platform, arch);
  // 目录键本身不携带来源；Beta 目录同时承载原生 Beta 和稳定兼容晋升。
  const parsed = parseVersion(version);
  if (channel === "stable" && parsed.beta !== null) fail("stable 只接受正式版");
  const root = `desktop/${channel}/${platform}/${arch}`;
  return {
    latest: `${root}/catalog/latest.json`,
    release: `${root}/catalog/releases/${version}/release.json`,
    nativeMetadata: `${root}/${BETA_TARGETS.get(targetId)}`,
  };
}

function assertPlainRecord(raw, label) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${label} 必须是对象`);
}

/** 校验并返回平台 latest.json 的合同字段。 */
export function parsePlatformLatest(raw, expected) {
  assertPlainRecord(raw, "latest");
  assertExpected(expected);
  if (raw.schemaVersion !== 2) fail("latest schemaVersion 必须为 2");
  if (raw.channel !== expected.channel) fail("latest 渠道与 expected 不一致");
  if (raw.platform !== expected.platform || raw.arch !== expected.arch) fail("latest 平台或架构不一致");
  const parsedVersion = parseVersion(raw.version);
  // latest 没有 sourceChannel；Beta 可指向原生 Beta 或 Stable 正式版兼容晋升。
  if (expected.channel === "stable" && parsedVersion.beta !== null) fail("stable 只接受正式版");
  if (
    expected.channel === "beta"
    && parsedVersion.beta === null
    && (expected.platform !== "windows" || expected.arch !== "x64")
  ) {
    fail("Beta Stable 兼容晋升只批准 windows/x64");
  }
  const keys = platformReleaseKeys(expected.channel, expected.platform, expected.arch, raw.version);
  if (typeof raw.release !== "string" || raw.release.includes("..") || raw.release.startsWith("http") || raw.release !== keys.release) {
    if (typeof raw.release === "string" && raw.release.split("/")[1] !== expected.channel) fail("release 必须位于同一通道");
    fail("release 路径无效");
  }
  return {
    schemaVersion: 2,
    channel: raw.channel,
    platform: raw.platform,
    arch: raw.arch,
    version: raw.version,
    release: raw.release,
  };
}

function validateArtifact(artifact, index, prefix) {
  assertPlainRecord(artifact, `artifacts[${index}]`);
  if (typeof artifact.path !== "string" || artifact.path !== `${prefix}/${artifact.fileName}` || artifact.path.includes("..")) fail(`artifacts[${index}] path 无效`);
  if (typeof artifact.fileName !== "string" || !artifact.fileName || artifact.fileName.includes("/")) fail(`artifacts[${index}] fileName 无效`);
  if (typeof artifact.kind !== "string" || !artifact.kind) fail(`artifacts[${index}] kind 无效`);
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) fail(`artifacts[${index}] size 无效`);
  if (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)) fail(`artifacts[${index}] sha256 无效`);
}

/** 校验并返回平台 release.json 的合同字段。 */
export function parsePlatformRelease(raw, expected) {
  assertPlainRecord(raw, "release");
  assertExpected(expected);
  if (raw.schemaVersion !== 2) fail("release schemaVersion 必须为 2");
  if (raw.channel !== expected.channel || raw.platform !== expected.platform || raw.arch !== expected.arch) fail("release 目标不一致");
  assertChannel(raw.sourceChannel);
  if (raw.channel === "stable" && raw.sourceChannel !== "stable") fail("sourceChannel 必须为 stable");
  if (raw.channel === "beta" && raw.sourceChannel === "beta" && parseVersion(raw.version).beta === null) fail("sourceChannel=beta 只接受 Beta 版本");
  if (raw.channel === "beta" && raw.sourceChannel === "stable" && parseVersion(raw.version).beta !== null) fail("sourceChannel=stable 只接受正式版");
  if (
    raw.channel === "beta"
    && raw.sourceChannel === "stable"
    && (raw.platform !== "windows" || raw.arch !== "x64")
  ) {
    fail("Stable 来源兼容发布只批准 windows/x64");
  }
  assertVersionForChannel(raw.version, raw.channel, raw.sourceChannel);
  if (raw.tag !== `v${raw.version}`) fail("tag 必须与 version 一致");
  if (typeof raw.commitSha !== "string" || !/^[0-9a-f]{40}$/.test(raw.commitSha)) fail("commitSha 必须为 40 位小写 hex");
  const keys = platformReleaseKeys(raw.channel, raw.platform, raw.arch, raw.version);
  if (raw.nativeMetadata !== keys.nativeMetadata) fail("nativeMetadata 路径无效");
  if (!Array.isArray(raw.artifacts)) fail("artifacts 必须为数组");
  const prefix = `desktop/${raw.channel}/${raw.platform}/${raw.arch}`;
  raw.artifacts.forEach((artifact, index) => validateArtifact(artifact, index, prefix));
  return {
    schemaVersion: 2,
    channel: raw.channel,
    sourceChannel: raw.sourceChannel,
    platform: raw.platform,
    arch: raw.arch,
    version: raw.version,
    tag: raw.tag,
    commitSha: raw.commitSha,
    nativeMetadata: raw.nativeMetadata,
    artifacts: raw.artifacts,
  };
}

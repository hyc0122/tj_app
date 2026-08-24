export const RELEASE_TARGETS = Object.freeze({
  "windows-x64": Object.freeze({
    id: "windows-x64", platform: "windows", processPlatform: "win32",
    builderPlatform: "win", arch: "x64", runner: "windows-2025",
    metadataFile: "latest.yml", releaseMetadataFile: "latest-windows-x64.yml",
    binaryExtensions: [".exe"],
  }),
  "macos-x64": Object.freeze({
    id: "macos-x64", platform: "macos", processPlatform: "darwin",
    builderPlatform: "mac", arch: "x64", runner: "macos-15-intel",
    metadataFile: "latest-mac.yml", releaseMetadataFile: "latest-mac-x64.yml",
    binaryExtensions: [".dmg", ".zip"],
  }),
  "macos-arm64": Object.freeze({
    id: "macos-arm64", platform: "macos", processPlatform: "darwin",
    builderPlatform: "mac", arch: "arm64", runner: "macos-15",
    metadataFile: "latest-mac.yml", releaseMetadataFile: "latest-mac-arm64.yml",
    binaryExtensions: [".dmg", ".zip"],
  }),
  "linux-x64": Object.freeze({
    id: "linux-x64", platform: "linux", processPlatform: "linux",
    builderPlatform: "linux", arch: "x64", runner: "ubuntu-24.04",
    metadataFile: "latest-linux.yml", releaseMetadataFile: "latest-linux-x64.yml",
    binaryExtensions: [".AppImage"],
  }),
  "linux-arm64": Object.freeze({
    id: "linux-arm64", platform: "linux", processPlatform: "linux",
    builderPlatform: "linux", arch: "arm64", runner: "ubuntu-24.04-arm",
    metadataFile: "latest-linux.yml", releaseMetadataFile: "latest-linux-arm64.yml",
    binaryExtensions: [".AppImage"],
  }),
});

export function resolveReleaseTarget(id) {
  // 只允许目标表自身字段，阻断 __proto__、constructor 等原型链键。
  if (!Object.hasOwn(RELEASE_TARGETS, id)) {
    throw new Error(`未知发布目标：${String(id)}`);
  }
  return RELEASE_TARGETS[id];
}

export function resolveReleaseTargetId(platform, arch) {
  const entry = Object.values(RELEASE_TARGETS)
    .find((target) => target.processPlatform === platform && target.arch === arch);
  if (!entry) throw new Error("不支持的更新平台或架构");
  return entry.id;
}

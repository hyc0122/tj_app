import assert from "node:assert/strict";
import test from "node:test";

import {
  compareDesktopVersions,
  parsePlatformLatest,
  parsePlatformRelease,
  platformReleaseKeys,
} from "../../scripts/platform-release-contract.mjs";

test("正式版高于同基线 Beta，平台 Key 固定在 Windows x64", () => {
  assert.equal(compareDesktopVersions("1.1.11", "1.1.11-beta.9"), 1);
  assert.deepEqual(platformReleaseKeys("stable", "windows", "x64", "1.1.11"), {
    latest: "desktop/stable/windows/x64/catalog/latest.json",
    release: "desktop/stable/windows/x64/catalog/releases/1.1.11/release.json",
    nativeMetadata: "desktop/stable/windows/x64/latest.yml",
  });
});

test("平台指针拒绝跨通道 release", () => {
  assert.throws(() => parsePlatformLatest({
    schemaVersion: 2,
    channel: "stable",
    platform: "windows",
    arch: "x64",
    version: "1.1.11",
    release: "desktop/beta/windows/x64/catalog/releases/1.1.11/release.json",
  }, { channel: "stable", platform: "windows", arch: "x64" }), /同一通道/);
});

test("平台指针严格校验版本与路径并返回稳定字段", () => {
  const raw = {
    schemaVersion: 2,
    channel: "beta",
    platform: "windows",
    arch: "x64",
    version: "1.1.11-beta.9",
    release: "desktop/beta/windows/x64/catalog/releases/1.1.11-beta.9/release.json",
  };
  assert.deepEqual(parsePlatformLatest(raw, { channel: "beta", platform: "windows", arch: "x64" }), raw);
  assert.throws(() => parsePlatformLatest({ ...raw, release: `${raw.release}/../evil` }, { channel: "beta", platform: "windows", arch: "x64" }), /路径/);
  assert.throws(() => parsePlatformLatest({ ...raw, version: "1.1.11-alpha.1" }, { channel: "beta", platform: "windows", arch: "x64" }), /版本/);
});

test("Beta 平台指针允许 Stable 正式版兼容晋升且仍固定在 Beta 通道", () => {
  const promoted = {
    schemaVersion: 2,
    channel: "beta",
    platform: "windows",
    arch: "x64",
    version: "1.1.11",
    release: "desktop/beta/windows/x64/catalog/releases/1.1.11/release.json",
  };
  assert.deepEqual(
    parsePlatformLatest(promoted, { channel: "beta", platform: "windows", arch: "x64" }),
    promoted,
  );
});

test("发布记录接受稳定原生、Beta 原生和稳定兼容晋升来源", () => {
  const base = {
    schemaVersion: 2,
    channel: "beta",
    sourceChannel: "stable",
    platform: "windows",
    arch: "x64",
    version: "1.1.11",
    tag: "v1.1.11",
    commitSha: "a".repeat(40),
    nativeMetadata: "desktop/beta/windows/x64/latest.yml",
    artifacts: [],
  };
  assert.deepEqual(parsePlatformRelease(base, { channel: "beta", platform: "windows", arch: "x64" }), base);
  assert.deepEqual(parsePlatformRelease({ ...base, channel: "stable", sourceChannel: "stable", nativeMetadata: "desktop/stable/windows/x64/latest.yml" }, { channel: "stable", platform: "windows", arch: "x64" }).channel, "stable");
  assert.deepEqual(parsePlatformRelease({ ...base, version: "1.1.11-beta.9", tag: "v1.1.11-beta.9", sourceChannel: "beta" }, { channel: "beta", platform: "windows", arch: "x64" }).sourceChannel, "beta");
  assert.throws(() => parsePlatformRelease({ ...base, sourceChannel: "beta", version: "1.1.11" }, { channel: "beta", platform: "windows", arch: "x64" }), /sourceChannel/);
});

test("版本比较按主次补丁和 Beta 数字排序", () => {
  assert.equal(compareDesktopVersions("1.2.0", "1.1.99"), 1);
  assert.equal(compareDesktopVersions("1.1.11-beta.2", "1.1.11-beta.10"), -1);
  assert.equal(compareDesktopVersions("1.1.11", "1.1.11"), 0);
  assert.throws(() => compareDesktopVersions("1.1.11-rc.1", "1.1.11"), /版本/);
});

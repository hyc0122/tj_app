import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { resolveReleaseContext } from "../../scripts/resolve-release-context.mjs";
import {
  RELEASE_TARGETS,
  resolveReleaseTarget,
  resolveReleaseTargetId,
} from "../../scripts/release-targets.mjs";

const EXPECTED_RELEASE_TARGETS = {
  "windows-x64": {
    id: "windows-x64", platform: "windows", processPlatform: "win32",
    builderPlatform: "win", arch: "x64", runner: "windows-2025",
    metadataFile: "latest.yml", releaseMetadataFile: "latest-windows-x64.yml",
    binaryExtensions: [".exe"],
  },
  "macos-x64": {
    id: "macos-x64", platform: "macos", processPlatform: "darwin",
    builderPlatform: "mac", arch: "x64", runner: "macos-15-intel",
    metadataFile: "latest-mac.yml", releaseMetadataFile: "latest-mac-x64.yml",
    binaryExtensions: [".dmg", ".zip"],
  },
  "macos-arm64": {
    id: "macos-arm64", platform: "macos", processPlatform: "darwin",
    builderPlatform: "mac", arch: "arm64", runner: "macos-15",
    metadataFile: "latest-mac.yml", releaseMetadataFile: "latest-mac-arm64.yml",
    binaryExtensions: [".dmg", ".zip"],
  },
  "linux-x64": {
    id: "linux-x64", platform: "linux", processPlatform: "linux",
    builderPlatform: "linux", arch: "x64", runner: "ubuntu-24.04",
    metadataFile: "latest-linux.yml", releaseMetadataFile: "latest-linux-x64.yml",
    binaryExtensions: [".AppImage"],
  },
  "linux-arm64": {
    id: "linux-arm64", platform: "linux", processPlatform: "linux",
    builderPlatform: "linux", arch: "arm64", runner: "ubuntu-24.04-arm",
    metadataFile: "latest-linux.yml", releaseMetadataFile: "latest-linux-arm64.yml",
    binaryExtensions: [".AppImage"],
  },
} as const;

test("发布目标表固定五个平台架构组合及全部发布字段", () => {
  assert.deepEqual(RELEASE_TARGETS, EXPECTED_RELEASE_TARGETS);
});

for (const id of Object.keys(EXPECTED_RELEASE_TARGETS) as Array<keyof typeof EXPECTED_RELEASE_TARGETS>) {
  test(`按 ID 解析完整发布目标：${id}`, () => {
    assert.deepEqual(resolveReleaseTarget(id), EXPECTED_RELEASE_TARGETS[id]);
  });
}

for (const [platform, arch, expectedId] of [
  ["win32", "x64", "windows-x64"],
  ["darwin", "x64", "macos-x64"],
  ["darwin", "arm64", "macos-arm64"],
  ["linux", "x64", "linux-x64"],
  ["linux", "arm64", "linux-arm64"],
] as const) {
  test(`按进程平台和架构解析目标：${platform}/${arch}`, () => {
    assert.equal(resolveReleaseTargetId(platform, arch), expectedId);
  });
}

for (const id of ["missing", "__proto__", "constructor"] as const) {
  test(`未知发布目标必须失败关闭：${id}`, () => {
    assert.throws(() => resolveReleaseTarget(id as never), /未知发布目标/);
  });
}

test("不支持的平台架构组合必须失败关闭", () => {
  assert.throws(
    () => resolveReleaseTargetId("win32", "arm64"),
    /不支持的更新平台或架构/,
  );
  assert.throws(
    () => resolveReleaseTargetId("freebsd" as never, "x64"),
    /不支持的更新平台或架构/,
  );
});

test("发布上下文区分与 package.json 一致的 Stable 与 beta.N Tag", () => {
  assert.deepEqual(
    resolveReleaseContext("tag", "v1.1.10", "1.1.10"),
    {
      version: "1.1.10",
      tag: "v1.1.10",
      channel: "stable",
      prerelease: false,
    },
  );
  assert.deepEqual(
    resolveReleaseContext("tag", "v1.1.10-beta.1", "1.1.10-beta.1"),
    {
      version: "1.1.10-beta.1",
      tag: "v1.1.10-beta.1",
      channel: "beta",
      prerelease: true,
    },
  );
});

for (const [tag, version] of [
  ["v1.1.10-alpha.1", "1.1.10-alpha.1"],
  ["v1.1.10-beta", "1.1.10-beta"],
  ["v1.1.10-beta.01", "1.1.10-beta.01"],
] as const) {
  test(`拒绝非正式版且非 beta.N 发布：${tag}`, () => {
    assert.throws(
      () => resolveReleaseContext("tag", tag, version),
      /只允许正式版或 beta\.N Tag/,
    );
  });
}

test("标签版本必须与 package.json 完全一致", () => {
  assert.throws(
    () => resolveReleaseContext("tag", "v1.1.10-beta.1", "1.1.10-beta.3"),
    /Tag 版本与 package.json 不一致/,
  );
});

test("工作流调用的 CLI 分别输出合法 Stable 与 beta.N 上下文", () => {
  const script = path.resolve("scripts", "resolve-release-context.mjs");
  const beta = spawnSync(process.execPath, [script, "tag", "v1.1.10-beta.1", "1.1.10-beta.1"], {
    encoding: "utf8",
  });
  assert.equal(beta.status, 0, beta.stderr);
  assert.deepEqual(JSON.parse(beta.stdout), {
    version: "1.1.10-beta.1",
    tag: "v1.1.10-beta.1",
    channel: "beta",
    prerelease: true,
  });

  const stable = spawnSync(
    process.execPath,
    [script, "tag", "v1.1.10", "1.1.10"],
    { encoding: "utf8" },
  );
  assert.equal(stable.status, 0, stable.stderr);
  assert.deepEqual(JSON.parse(stable.stdout), {
    version: "1.1.10",
    tag: "v1.1.10",
    channel: "stable",
    prerelease: false,
  });
});

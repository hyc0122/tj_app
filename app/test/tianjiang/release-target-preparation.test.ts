import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// @ts-expect-error 发布归一化脚本保持原生 ESM，由真实 Node 入口与测试共用。
import { prepareReleaseTarget } from "../../scripts/prepare-release-target.mjs";

const VERSION = "1.1.10-beta.1";
const fixtureParent = path.resolve("..", ".tmp");

/**
 * Windows 实时扫描器可能短暂占用刚写入的夹具目录；清理失败不得把已通过的断言记为产品失败。
 * 有界重试后仍 EPERM 时保留残留于 .tmp，不抛出。
 */
function bestEffortRm(target: string): void {
  if (!target || !fs.existsSync(target)) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") throw error;
      // 250ms / 500ms
      const waitMs = 250 * (attempt + 1);
      const end = Date.now() + waitMs;
      while (Date.now() < end) {
        /* spin-wait: 测试清理路径禁止依赖系统 TEMP 或 setTimeout 泄漏句柄 */
      }
    }
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha512(bytes: Buffer): string {
  return createHash("sha512").update(bytes).digest("base64");
}

function createWindowsSource(): {
  root: string;
  setupName: string;
  setup: Buffer;
  blockmapName: string;
  blockmap: Buffer;
  metadata: Buffer;
} {
  fs.mkdirSync(fixtureParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureParent, "release-target-source-"));
  const setupName = `天将漫创-${VERSION}-win-x64-setup.exe`;
  const blockmapName = `${setupName}.blockmap`;
  const setup = Buffer.from("unsigned-windows-setup\n", "utf8");
  const blockmap = Buffer.from("windows-blockmap\n", "utf8");
  const metadata = Buffer.from([
    `version: ${VERSION}`,
    "files:",
    `  - url: ${setupName}`,
    `    sha512: ${sha512(setup)}`,
    `    size: ${setup.length}`,
    `path: ${setupName}`,
    `sha512: ${sha512(setup)}`,
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(root, setupName), setup);
  fs.writeFileSync(path.join(root, blockmapName), blockmap);
  fs.writeFileSync(path.join(root, "latest.yml"), metadata);
  return { root, setupName, setup, blockmapName, blockmap, metadata };
}

test("单目标归一化只产生 files 与稳定字段顺序的 target-index.json", () => {
  const fixture = createWindowsSource();
  const destination = path.join(fixtureParent, `release-target-${process.pid}-${Date.now()}`);
  try {
    const index = prepareReleaseTarget({
      sourceRoot: fixture.root,
      destinationRoot: destination,
      targetId: "windows-x64",
      version: VERSION,
    });

    assert.deepEqual(fs.readdirSync(destination).sort(), ["files", "target-index.json"]);
    assert.deepEqual(fs.readdirSync(path.join(destination, "files")).sort(), [
      "latest.yml",
      fixture.setupName,
      fixture.blockmapName,
    ].sort());
    assert.deepEqual(Object.keys(index), [
      "schemaVersion",
      "targetId",
      "platform",
      "arch",
      "metadataFile",
      "files",
    ]);
    for (const file of index.files) {
      assert.deepEqual(Object.keys(file), ["fileName", "kind", "size", "sha256"]);
    }
    const expected = {
      schemaVersion: 1,
      targetId: "windows-x64",
      platform: "windows",
      arch: "x64",
      metadataFile: "latest.yml",
      files: [
        { fileName: "latest.yml", kind: "metadata", size: fixture.metadata.length, sha256: sha256(fixture.metadata) },
        { fileName: fixture.blockmapName, kind: "blockmap", size: fixture.blockmap.length, sha256: sha256(fixture.blockmap) },
        { fileName: fixture.setupName, kind: "installer", size: fixture.setup.length, sha256: sha256(fixture.setup) },
      ].sort((left, right) => left.fileName.localeCompare(right.fileName, "en")),
    };
    assert.deepEqual(index, expected);
    assert.equal(
      fs.readFileSync(path.join(destination, "target-index.json"), "utf8"),
      `${JSON.stringify(expected, null, 2)}\n`,
    );
  } finally {
    bestEffortRm(fixture.root);
    bestEffortRm(destination);
  }
});

test("单目标归一化拒绝额外二进制且不留下半包", () => {
  const fixture = createWindowsSource();
  const destination = path.join(fixtureParent, `release-target-extra-${process.pid}-${Date.now()}`);
  fs.writeFileSync(path.join(fixture.root, `天将漫创-${VERSION}-win-x64-copy.exe`), "extra", "utf8");
  try {
    assert.throws(() => prepareReleaseTarget({
      sourceRoot: fixture.root,
      destinationRoot: destination,
      targetId: "windows-x64",
      version: VERSION,
    }), /额外|集合/);
    assert.equal(fs.existsSync(destination), false);
  } finally {
    bestEffortRm(fixture.root);
    bestEffortRm(destination);
  }
});

test("单目标归一化拒绝符号链接且不跟随目标内容", () => {
  const fixture = createWindowsSource();
  const destination = path.join(fixtureParent, `release-target-link-${process.pid}-${Date.now()}`);
  const linkSource = path.join(fixture.root, "link-source");
  fs.mkdirSync(linkSource);
  fs.rmSync(path.join(fixture.root, fixture.setupName));
  // Windows junction 不需要管理员权限，且 lstat 会将它识别为符号链接。
  fs.symlinkSync(linkSource, path.join(fixture.root, fixture.setupName), "junction");
  try {
    assert.throws(() => prepareReleaseTarget({
      sourceRoot: fixture.root,
      destinationRoot: destination,
      targetId: "windows-x64",
      version: VERSION,
    }), /符号链接/);
    assert.equal(fs.existsSync(destination), false);
  } finally {
    bestEffortRm(fixture.root);
    bestEffortRm(destination);
  }
});

test("单目标归一化拒绝 metadata 摘要不一致", () => {
  const fixture = createWindowsSource();
  const destination = path.join(fixtureParent, `release-target-digest-${process.pid}-${Date.now()}`);
  const metadataPath = path.join(fixture.root, "latest.yml");
  fs.writeFileSync(
    metadataPath,
    fs.readFileSync(metadataPath, "utf8").replace(sha512(fixture.setup), "invalid-sha512"),
    "utf8",
  );
  try {
    assert.throws(() => prepareReleaseTarget({
      sourceRoot: fixture.root,
      destinationRoot: destination,
      targetId: "windows-x64",
      version: VERSION,
    }), /SHA-512 不一致/);
    assert.equal(fs.existsSync(destination), false);
  } finally {
    bestEffortRm(fixture.root);
    bestEffortRm(destination);
  }
});

test("单目标归一化拒绝目标 ID 与架构不一致", () => {
  const fixture = createWindowsSource();
  const destination = path.join(fixtureParent, `release-target-arch-${process.pid}-${Date.now()}`);
  try {
    assert.throws(() => prepareReleaseTarget({
      sourceRoot: fixture.root,
      destinationRoot: destination,
      targetId: "macos-arm64",
      version: VERSION,
    }), /缺失|集合|架构/);
    assert.equal(fs.existsSync(destination), false);
  } finally {
    bestEffortRm(fixture.root);
    bestEffortRm(destination);
  }
});

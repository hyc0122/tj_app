import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// @ts-expect-error 发布脚本保持原生 ESM，由 GitHub Actions 与测试共同调用。
import { preparePlatformReleasePublication } from "../../scripts/prepare-platform-release-publication.mjs";
// @ts-expect-error 聚合清单脚本保持原生 ESM，由 GitHub Actions 与测试共同调用。
import { buildReleaseManifest } from "../../scripts/build-release-manifest.mjs";

const VERSION = "1.1.11";
const COMMIT_SHA = "a".repeat(40);
const fixtureParent = path.resolve(process.cwd(), "..", ".tmp", "stable-windows-release-publication");

test("Stable 上下文从单个 Windows x64 传递包生成平台来源清单", () => {
  const fixture = createSourceFixture("stable-manifest");
  const outputRoot = path.join(fixture.root, "manifest-output");
  try {
    const result = buildReleaseManifest({
      targetsRoot: fixture.targetRoot,
      outputRoot,
      context: {
        version: VERSION,
        tag: `v${VERSION}`,
        channel: "stable",
        sourceChannel: "stable",
        platform: "windows",
        arch: "x64",
        commitSha: COMMIT_SHA,
        repository: "hyc0122/tianjiang-manchuang",
        workflow: ".github/workflows/app-stable-release.yml",
        runId: "9001",
        runAttempt: "1",
        generatedAt: "2026-08-24T00:00:00.000Z",
      },
    });
    assert.equal(result.manifest.schemaVersion, 2);
    assert.equal(result.manifest.channel, "stable");
    assert.equal(result.manifest.sourceChannel, "stable");
    assert.equal(result.manifest.platform, "windows");
    assert.equal(result.manifest.arch, "x64");
    assert.equal(result.manifest.artifacts.length, 3);
    assert.ok(result.manifest.artifacts.every((artifact: { path: string }) => (
      artifact.path.startsWith("desktop/stable/windows/x64/")
    )));

    assert.throws(() => buildReleaseManifest({
      targetsRoot: fixture.targetRoot,
      outputRoot: path.join(fixture.root, "wrong-workflow-output"),
      context: {
        ...result.manifest,
        workflow: ".github/workflows/app-release.yml",
      },
    }), /Stable.*工作流|workflow|来源/);
  } finally {
    removeTree(fixture.root);
  }
});

test("Stable 本地准备只生成 Windows x64 Stable 与 Beta 兼容树", () => {
  const fixture = createSourceFixture("dual-channel");
  const destinationRoot = path.join(fixture.root, "publication");
  const signedManifests: Buffer[] = [];
  try {
    const result = preparePlatformReleasePublication({
      targetRoot: fixture.targetRoot,
      manifestPath: fixture.manifestPath,
      sha256SumsPath: fixture.sha256SumsPath,
      sigstoreBundlePath: fixture.sigstoreBundlePath,
      destinationRoot,
      channel: "stable",
      sourceChannel: "stable",
      version: VERSION,
      signer: (manifestBytes: Buffer) => {
        signedManifests.push(Buffer.from(manifestBytes));
        return sigstoreBytes(manifestBytes, "offline-beta-source-proof");
      },
    });

    assert.deepEqual(result.channels, ["stable", "beta"]);
    assert.equal(result.version, VERSION);
    const keys = listKeys(destinationRoot);
    assert.ok(keys.length > 0);
    assert.equal(keys.some((key) => /macos|linux/.test(key)), false);
    assert.ok(keys.every((key) => /^desktop\/(?:stable|beta)\/windows\/x64\//.test(key)));
    assert.equal(keys.includes("desktop/beta/catalog/latest.json"), false);

    for (const channel of ["stable", "beta"] as const) {
      const prefix = `desktop/${channel}/windows/x64`;
      const release = readJson(path.join(
        destinationRoot,
        ...`${prefix}/catalog/releases/${VERSION}/release.json`.split("/"),
      ));
      const latest = readJson(path.join(destinationRoot, ...`${prefix}/catalog/latest.json`.split("/")));
      assert.equal(release.schemaVersion, 2);
      assert.equal(release.channel, channel);
      assert.equal(release.sourceChannel, "stable");
      assert.equal(release.platform, "windows");
      assert.equal(release.arch, "x64");
      assert.equal(release.artifacts.length, 2);
      assert.ok(release.artifacts.every((artifact: { path: string }) => artifact.path.startsWith(`${prefix}/`)));
      assert.deepEqual(latest, {
        schemaVersion: 2,
        channel,
        platform: "windows",
        arch: "x64",
        version: VERSION,
        release: `${prefix}/catalog/releases/${VERSION}/release.json`,
      });
      assert.equal(fs.existsSync(path.join(destinationRoot, ...`${prefix}/latest.yml`.split("/"))), true);
    }
    const stableReleaseRoot = `desktop/stable/windows/x64/catalog/releases/${VERSION}`;
    const betaReleaseRoot = `desktop/beta/windows/x64/catalog/releases/${VERSION}`;
    const stableManifestBytes = fs.readFileSync(path.join(destinationRoot, ...`${stableReleaseRoot}/release-manifest.json`.split("/")));
    const betaManifestBytes = fs.readFileSync(path.join(destinationRoot, ...`${betaReleaseRoot}/release-manifest.json`.split("/")));
    const betaManifest = JSON.parse(betaManifestBytes.toString("utf8"));
    const betaSums = fs.readFileSync(path.join(destinationRoot, ...`${betaReleaseRoot}/SHA256SUMS`.split("/")), "utf8");
    const betaBundle = readJson(path.join(destinationRoot, ...`${betaReleaseRoot}/release-manifest.json.sigstore.json`.split("/")));

    assert.equal(signedManifests.length, 1);
    assert.deepEqual(signedManifests[0], betaManifestBytes);
    assert.notDeepEqual(betaManifestBytes, stableManifestBytes);
    assert.equal(betaManifest.channel, "beta");
    assert.equal(betaManifest.sourceChannel, "stable");
    assert.ok(betaManifest.artifacts.every((artifact: { path: string }) => artifact.path.startsWith("desktop/beta/windows/x64/")));
    assert.equal(betaSums, `${betaManifest.artifacts.map((artifact: { sha256: string; path: string }) => `${artifact.sha256}  ${artifact.path}`).join("\n")}\n`);
    assert.equal(
      betaBundle.messageSignature.messageDigest.digest,
      crypto.createHash("sha256").update(betaManifestBytes).digest("base64"),
    );
  } finally {
    removeTree(fixture.root);
  }
});

test("缺少 Beta 来源证明 signer 时失败关闭且不留下半包", () => {
  const fixture = createSourceFixture("missing-beta-signer");
  const destinationRoot = path.join(fixture.root, "publication");
  try {
    assert.throws(() => preparePlatformReleasePublication({
      targetRoot: fixture.targetRoot,
      manifestPath: fixture.manifestPath,
      sha256SumsPath: fixture.sha256SumsPath,
      sigstoreBundlePath: fixture.sigstoreBundlePath,
      destinationRoot,
      channel: "stable",
      sourceChannel: "stable",
      version: VERSION,
    }), /signer|签名|来源证明/);
    assert.equal(fs.existsSync(destinationRoot), false);
  } finally {
    removeTree(fixture.root);
  }
});

test("缺少 Windows blockmap 时拒绝留下半包", () => {
  const fixture = createSourceFixture("missing-blockmap");
  const destinationRoot = path.join(fixture.root, "publication");
  fs.rmSync(path.join(fixture.targetRoot, "files", fixture.blockmapName));
  try {
    assert.throws(() => preparePlatformReleasePublication({
      targetRoot: fixture.targetRoot,
      manifestPath: fixture.manifestPath,
      sha256SumsPath: fixture.sha256SumsPath,
      sigstoreBundlePath: fixture.sigstoreBundlePath,
      destinationRoot,
      channel: "stable",
      sourceChannel: "stable",
      version: VERSION,
    }), /blockmap|缺失|文件集合/);
    assert.equal(fs.existsSync(destinationRoot), false);
  } finally {
    removeTree(fixture.root);
  }
});

test("单目标传递包出现其他平台对象时在提交前失败", () => {
  const fixture = createSourceFixture("foreign-platform");
  const destinationRoot = path.join(fixture.root, "publication");
  fs.writeFileSync(path.join(fixture.targetRoot, "files", "unexpected-linux.AppImage"), "foreign", "utf8");
  try {
    assert.throws(() => preparePlatformReleasePublication({
      targetRoot: fixture.targetRoot,
      manifestPath: fixture.manifestPath,
      sha256SumsPath: fixture.sha256SumsPath,
      sigstoreBundlePath: fixture.sigstoreBundlePath,
      destinationRoot,
      channel: "stable",
      sourceChannel: "stable",
      version: VERSION,
    }), /缺失、多余|文件集合|越界/);
    assert.equal(fs.existsSync(destinationRoot), false);
  } finally {
    removeTree(fixture.root);
  }
});

export function createSourceFixture(name: string) {
  fs.mkdirSync(fixtureParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureParent, `${name}-`));
  const targetRoot = path.join(root, "windows-x64");
  const filesRoot = path.join(targetRoot, "files");
  fs.mkdirSync(filesRoot, { recursive: true });
  const installerName = `天将漫创-${VERSION}-win-x64-setup.exe`;
  const blockmapName = `${installerName}.blockmap`;
  const installerBytes = Buffer.from("offline-stable-windows-installer\n", "utf8");
  const blockmapBytes = Buffer.from("offline-stable-windows-blockmap\n", "utf8");
  const latestBytes = Buffer.from([
    `version: ${VERSION}`,
    "files:",
    `  - url: ${installerName}`,
    `    sha512: ${sha512(installerBytes)}`,
    `    size: ${installerBytes.length}`,
    `path: ${installerName}`,
    `sha512: ${sha512(installerBytes)}`,
    "",
  ].join("\n"), "utf8");
  const sourceFiles = [
    { fileName: installerName, kind: "installer", bytes: installerBytes },
    { fileName: blockmapName, kind: "blockmap", bytes: blockmapBytes },
    { fileName: "latest.yml", kind: "metadata", bytes: latestBytes },
  ].sort((left, right) => left.fileName.localeCompare(right.fileName, "en"));
  for (const file of sourceFiles) fs.writeFileSync(path.join(filesRoot, file.fileName), file.bytes);
  fs.writeFileSync(path.join(targetRoot, "target-index.json"), jsonBytes({
    schemaVersion: 1,
    targetId: "windows-x64",
    platform: "windows",
    arch: "x64",
    metadataFile: "latest.yml",
    files: sourceFiles.map((file) => ({
      fileName: file.fileName,
      kind: file.kind,
      size: file.bytes.length,
      sha256: sha256(file.bytes),
    })),
  }));

  const manifestArtifacts = sourceFiles.map((file) => ({
    path: `desktop/stable/windows/x64/${file.fileName}`,
    fileName: file.fileName,
    platform: "windows",
    arch: "x64",
    kind: file.kind,
    size: file.bytes.length,
    sha256: sha256(file.bytes),
  })).sort((left, right) => left.path.localeCompare(right.path, "en"));
  const manifest = {
    schemaVersion: 2,
    version: VERSION,
    tag: `v${VERSION}`,
    channel: "stable",
    sourceChannel: "stable",
    platform: "windows",
    arch: "x64",
    commitSha: COMMIT_SHA,
    repository: "hyc0122/tianjiang-manchuang",
    workflow: ".github/workflows/app-stable-release.yml",
    runId: "9001",
    runAttempt: "1",
    generatedAt: "2026-08-24T00:00:00.000Z",
    artifacts: manifestArtifacts,
  };
  const manifestPath = path.join(root, "release-manifest.json");
  const manifestBytes = jsonBytes(manifest);
  fs.writeFileSync(manifestPath, manifestBytes);
  const sha256SumsPath = path.join(root, "SHA256SUMS");
  fs.writeFileSync(
    sha256SumsPath,
    `${manifestArtifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n")}\n`,
    "utf8",
  );
  const sigstoreBundlePath = path.join(root, "release-manifest.json.sigstore.json");
  fs.writeFileSync(sigstoreBundlePath, jsonBytes({
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: { tlogEntries: [] },
    messageSignature: {
      messageDigest: {
        algorithm: "SHA2_256",
        digest: crypto.createHash("sha256").update(manifestBytes).digest("base64"),
      },
      signature: Buffer.from("offline-stable-source-proof", "utf8").toString("base64"),
    },
  }));
  return {
    root,
    targetRoot,
    manifestPath,
    sha256SumsPath,
    sigstoreBundlePath,
    installerName,
    blockmapName,
  };
}

function listKeys(root: string): string[] {
  const keys: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else keys.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  };
  visit(root);
  return keys.sort((left, right) => left.localeCompare(right, "en"));
}

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function jsonBytes(value: unknown) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes: Buffer) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha512(bytes: Buffer) {
  return crypto.createHash("sha512").update(bytes).digest("base64");
}

function sigstoreBytes(manifestBytes: Buffer, signature: string) {
  return jsonBytes({
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: { tlogEntries: [] },
    messageSignature: {
      messageDigest: {
        algorithm: "SHA2_256",
        digest: crypto.createHash("sha256").update(manifestBytes).digest("base64"),
      },
      signature: Buffer.from(signature, "utf8").toString("base64"),
    },
  });
}

function removeTree(targetPath: string) {
  // Windows Defender/索引器可能短暂持有夹具，有限重试只用于测试清理。
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        !(error instanceof Error)
        || !("code" in error)
        || !["EPERM", "EBUSY", "ENOTEMPTY"].includes(String(error.code))
        || attempt === 19
      ) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

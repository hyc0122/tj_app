import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// @ts-expect-error 聚合清单脚本保持原生 ESM，由真实 Node 入口与测试共用。
import { buildReleaseManifest } from "../../scripts/build-release-manifest.mjs";
// @ts-expect-error 单目标准备脚本保持原生 ESM，由真实 Node 入口与测试共用。
import { prepareReleaseTarget } from "../../scripts/prepare-release-target.mjs";
// @ts-expect-error 发布脚本保持原生 ESM，由真实 Node 入口与测试共用。
import { prepareReleasePublication } from "../../scripts/prepare-release-publication.mjs";

const VERSION = "1.1.10-beta.1";
const fixtureParent = path.resolve("..", ".tmp");
const TARGET_SPECS = [
  {
    targetId: "windows-x64",
    platform: "windows",
    arch: "x64",
    metadataFile: "latest.yml",
    releaseMetadataFile: "latest-windows-x64.yml",
    artifacts: [
      `天将漫创-${VERSION}-win-x64-setup.exe`,
      `天将漫创-${VERSION}-win-x64-setup.exe.blockmap`,
    ],
    metadataBinaries: [`天将漫创-${VERSION}-win-x64-setup.exe`],
    primaryArtifact: `天将漫创-${VERSION}-win-x64-setup.exe`,
  },
  ...(["x64", "arm64"] as const).map((arch) => ({
    targetId: `macos-${arch}`,
    platform: "macos",
    arch,
    metadataFile: "latest-mac.yml",
    releaseMetadataFile: `latest-mac-${arch}.yml`,
    artifacts: [
      `天将漫创-${VERSION}-mac-${arch}.dmg`,
      `天将漫创-${VERSION}-mac-${arch}.zip`,
      `天将漫创-${VERSION}-mac-${arch}.zip.blockmap`,
    ],
    metadataBinaries: [
      `天将漫创-${VERSION}-mac-${arch}.dmg`,
      `天将漫创-${VERSION}-mac-${arch}.zip`,
    ],
    primaryArtifact: `天将漫创-${VERSION}-mac-${arch}.zip`,
  })),
  ...(["x64", "arm64"] as const).map((arch) => ({
    targetId: `linux-${arch}`,
    platform: "linux",
    arch,
    metadataFile: "latest-linux.yml",
    releaseMetadataFile: `latest-linux-${arch}.yml`,
    artifacts: [
      `天将漫创-${VERSION}-linux-${arch}.AppImage`,
      `天将漫创-${VERSION}-linux-${arch}.AppImage.blockmap`,
    ],
    metadataBinaries: [`天将漫创-${VERSION}-linux-${arch}.AppImage`],
    primaryArtifact: `天将漫创-${VERSION}-linux-${arch}.AppImage`,
  })),
] as const;

const CONTEXT = {
  version: VERSION,
  tag: `v${VERSION}`,
  channel: "beta",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  repository: "hyc0122/tianjiang-manchuang",
  workflow: ".github/workflows/app-release.yml",
  runId: "123456789",
  runAttempt: "2",
  generatedAt: "2026-08-02T00:00:00.000Z",
} as const;

type TargetSpec = (typeof TARGET_SPECS)[number];

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha512(bytes: Buffer): string {
  return createHash("sha512").update(bytes).digest("base64");
}

function retryFixtureIo<T>(action: () => T): T {
  // Windows 杀毒或索引器可能短暂占用刚读取的夹具，手工有限重试只用于测试 I/O。
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return action();
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
  throw new Error("测试夹具 I/O 重试次数耗尽");
}

function removeTree(root: string): void {
  retryFixtureIo(() => fs.rmSync(root, { recursive: true, force: true }));
}

function createSourceTarget(root: string, spec: TargetSpec): void {
  fs.mkdirSync(root, { recursive: true });
  const evidence = new Map<string, { sha512: string; size: number }>();
  for (const [index, fileName] of spec.artifacts.entries()) {
    const bytes = Buffer.from(`${spec.targetId}:${index}:${fileName}\n`, "utf8");
    fs.writeFileSync(path.join(root, fileName), bytes);
    if (spec.metadataBinaries.includes(fileName as never)) {
      evidence.set(fileName, { sha512: sha512(bytes), size: bytes.length });
    }
  }
  const primary = evidence.get(spec.primaryArtifact);
  assert.ok(primary);
  // 手工生成 update metadata，期望值不复用被测实现。
  fs.writeFileSync(path.join(root, spec.metadataFile), [
    `version: ${VERSION}`,
    "files:",
    ...spec.metadataBinaries.flatMap((fileName) => {
      const item = evidence.get(fileName);
      assert.ok(item);
      return [
        `  - url: ${fileName}`,
        `    sha512: ${item.sha512}`,
        `    size: ${item.size}`,
      ];
    }),
    `path: ${spec.primaryArtifact}`,
    `sha512: ${primary.sha512}`,
    "",
  ].join("\n"), "utf8");
}

function createFiveTargets(order = [2, 0, 4, 1, 3]): { root: string; rawRoot: string } {
  fs.mkdirSync(fixtureParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureParent, "release-targets-"));
  const rawRoot = fs.mkdtempSync(path.join(fixtureParent, "release-raw-"));
  for (const index of order) {
    const spec = TARGET_SPECS[index];
    const source = path.join(rawRoot, spec.targetId);
    createSourceTarget(source, spec);
    prepareReleaseTarget({
      sourceRoot: source,
      destinationRoot: path.join(root, spec.targetId),
      targetId: spec.targetId,
      version: VERSION,
    });
  }
  return { root, rawRoot };
}

function withFiveTargets(action: (fixture: { root: string; rawRoot: string }) => void): void {
  const fixture = createFiveTargets();
  try {
    action(fixture);
  } finally {
    removeTree(fixture.root);
    removeTree(fixture.rawRoot);
  }
}

function buildFixture(fixture: { root: string }, suffix: string): {
  outputRoot: string;
  manifestPath: string;
  sha256SumsPath: string;
} {
  const outputRoot = path.join(fixtureParent, `release-manifest-${suffix}-${process.pid}-${Date.now()}`);
  const result = buildReleaseManifest({ targetsRoot: fixture.root, outputRoot, context: CONTEXT });
  return {
    outputRoot,
    manifestPath: result.manifestPath,
    sha256SumsPath: result.sha256SumsPath,
  };
}

function createBundle(suffix: string, manifestPath: string): string {
  const bundlePath = path.join(fixtureParent, `release-manifest-${suffix}.sigstore.json`);
  const manifestBytes = fs.readFileSync(manifestPath);
  fs.writeFileSync(bundlePath, `${JSON.stringify({
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: { fixture: "public-source-provenance" },
    messageSignature: {
      messageDigest: {
        algorithm: "SHA2_256",
        digest: createHash("sha256").update(manifestBytes).digest("base64"),
      },
      signature: Buffer.from("sigstore-signature-fixture", "utf8").toString("base64"),
    },
  })}\n`, "utf8");
  return bundlePath;
}

test("单目标发布提交对 Windows 临时占用执行有界原子重试", () => {
  fs.mkdirSync(fixtureParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureParent, "release-rename-retry-"));
  const rawRoot = fs.mkdtempSync(path.join(fixtureParent, "release-rename-raw-"));
  const spec = TARGET_SPECS[0];
  const sourceRoot = path.join(rawRoot, spec.targetId);
  const destinationRoot = path.join(root, spec.targetId);
  createSourceTarget(sourceRoot, spec);
  const waits: number[] = [];
  let renameAttempts = 0;
  try {
    prepareReleaseTarget({
      sourceRoot,
      destinationRoot,
      targetId: spec.targetId,
      version: VERSION,
      commitRenameOptions: {
        renameSync: (source: string, destination: string) => {
          renameAttempts += 1;
          if (renameAttempts < 3) {
            throw Object.assign(new Error("fixture lock"), { code: "EPERM" });
          }
          fs.renameSync(source, destination);
        },
        wait: (milliseconds: number) => waits.push(milliseconds),
        maxAttempts: 201,
      },
    });
    assert.ok(renameAttempts >= 3);
    assert.deepEqual(waits.slice(0, 2), [50, 50]);
    assert.equal(fs.existsSync(destinationRoot), true);
  } finally {
    removeTree(root);
    removeTree(rawRoot);
  }
});

test("发布完成包提交对 Windows 临时占用执行有界原子重试", () => {
  withFiveTargets((fixture) => {
    const built = buildFixture(fixture, "publication-rename-retry");
    const bundlePath = createBundle(
      `publication-rename-retry-${process.pid}-${Date.now()}`,
      built.manifestPath,
    );
    const destination = path.join(
      fixtureParent,
      `release-publication-rename-retry-${process.pid}-${Date.now()}`,
    );
    const waits: number[] = [];
    let renameAttempts = 0;
    try {
      prepareReleasePublication({
        targetsRoot: fixture.root,
        manifestPath: built.manifestPath,
        sha256SumsPath: built.sha256SumsPath,
        sigstoreBundlePath: bundlePath,
        destinationRoot: destination,
        commitRenameOptions: {
          renameSync: (source: string, target: string) => {
            renameAttempts += 1;
            if (renameAttempts < 3) {
              throw Object.assign(new Error("fixture lock"), { code: "EPERM" });
            }
            fs.renameSync(source, target);
          },
          wait: (milliseconds: number) => waits.push(milliseconds),
          maxAttempts: 201,
        },
      });
      assert.ok(renameAttempts >= 3);
      assert.deepEqual(waits.slice(0, 2), [50, 50]);
      assert.equal(fs.existsSync(destination), true);
    } finally {
      removeTree(destination);
      removeTree(built.outputRoot);
      retryFixtureIo(() => fs.rmSync(bundlePath, { force: true }));
    }
  });
});

test("五目标输入顺序不影响 ReleaseManifest 与 SHA256SUMS 的逐字输出", () => {
  const first = createFiveTargets([2, 0, 4, 1, 3]);
  const second = createFiveTargets([4, 3, 2, 1, 0]);
  const firstOutput = path.join(fixtureParent, `release-manifest-first-${process.pid}-${Date.now()}`);
  const secondOutput = path.join(fixtureParent, `release-manifest-second-${process.pid}-${Date.now()}`);
  try {
    const firstResult = buildReleaseManifest({ targetsRoot: first.root, outputRoot: firstOutput, context: CONTEXT });
    const secondResult = buildReleaseManifest({ targetsRoot: second.root, outputRoot: secondOutput, context: CONTEXT });
    const firstManifest = fs.readFileSync(firstResult.manifestPath, "utf8");
    const firstSums = fs.readFileSync(firstResult.sha256SumsPath, "utf8");
    assert.equal(fs.readFileSync(secondResult.manifestPath, "utf8"), firstManifest);
    assert.equal(fs.readFileSync(secondResult.sha256SumsPath, "utf8"), firstSums);

    const manifest = JSON.parse(firstManifest) as {
      artifacts: Array<{ path: string; sha256: string }>;
    };
    const paths = manifest.artifacts.map((artifact) => artifact.path);
    assert.deepEqual(paths, [...paths].sort((left, right) => left.localeCompare(right, "en")));
    assert.equal(new Set(paths).size, 17);
    assert.equal(manifest.artifacts.length, 17);
    const lines = firstSums.trimEnd().split("\n");
    assert.equal(lines.length, 17);
    for (const [index, line] of lines.entries()) {
      assert.match(line, /^[0-9a-f]{64}  desktop\/beta\/(?:windows|macos|linux)\/(?:x64|arm64)\/[^/]+$/);
      assert.equal(line, `${manifest.artifacts[index].sha256}  ${manifest.artifacts[index].path}`);
    }
  } finally {
    for (const target of [first, second]) {
      removeTree(target.root);
      removeTree(target.rawRoot);
    }
    removeTree(firstOutput);
    removeTree(secondOutput);
  }
});

test("聚合清单逐字段拒绝非 Beta 上下文", () => {
  withFiveTargets((fixture) => {
    const invalidContexts = [
      { ...CONTEXT, version: "1.1.10" },
      { ...CONTEXT, tag: "v1.1.10-beta.3" },
      { ...CONTEXT, channel: "stable" },
      { ...CONTEXT, commitSha: "f".repeat(39) },
      { ...CONTEXT, repository: "other/repository" },
      { ...CONTEXT, workflow: ".github/workflows/other.yml" },
      { ...CONTEXT, runId: "1e3" },
      { ...CONTEXT, runAttempt: "0x2" },
      { ...CONTEXT, generatedAt: "2026-08-02 00:00:00" },
    ];
    for (const [index, context] of invalidContexts.entries()) {
      const outputRoot = path.join(fixtureParent, `invalid-context-${index}-${process.pid}-${Date.now()}`);
      assert.throws(
        () => buildReleaseManifest({ targetsRoot: fixture.root, outputRoot, context }),
        /上下文|Beta|Tag|commit|仓库|工作流|run|UTC|时间/,
      );
      assert.equal(fs.existsSync(outputRoot), false);
    }
  });
});

test("聚合清单拒绝五目标缺失、多余或重复", () => {
  for (const mutation of ["missing", "extra", "duplicate"] as const) {
    const fixture = createFiveTargets();
    const outputRoot = path.join(fixtureParent, `invalid-targets-${mutation}-${process.pid}-${Date.now()}`);
    try {
      if (mutation === "missing") {
        fs.rmSync(path.join(fixture.root, "linux-arm64"), { recursive: true, force: true });
      } else if (mutation === "extra") {
        fs.mkdirSync(path.join(fixture.root, "unexpected-target"));
      } else {
        const indexPath = path.join(fixture.root, "macos-arm64", "target-index.json");
        const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
        index.targetId = "macos-x64";
        fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
      }
      assert.throws(
        () => buildReleaseManifest({ targetsRoot: fixture.root, outputRoot, context: CONTEXT }),
        /五个|目标|重复|缺失|多余/,
      );
      assert.equal(fs.existsSync(outputRoot), false);
    } finally {
      removeTree(fixture.root);
      removeTree(fixture.rawRoot);
      removeTree(outputRoot);
    }
  }
});

test("发布完成包保留 OSS 原始 metadata，并为 GitHub 生成五个唯一名称", () => {
  withFiveTargets((fixture) => {
    const built = buildFixture(fixture, "success");
    const bundlePath = createBundle(`success-${process.pid}-${Date.now()}`, built.manifestPath);
    const destination = path.join(fixtureParent, `release-publication-${process.pid}-${Date.now()}`);
    try {
      prepareReleasePublication({
        targetsRoot: fixture.root,
        manifestPath: built.manifestPath,
        sha256SumsPath: built.sha256SumsPath,
        sigstoreBundlePath: bundlePath,
        destinationRoot: destination,
      });

      const githubFiles = fs.readdirSync(path.join(destination, "github-release")).sort();
      const expectedGithubFiles = [
        ...TARGET_SPECS.flatMap((spec) => [
          ...spec.artifacts,
          spec.releaseMetadataFile,
        ]),
        "release-manifest.json",
        "release-manifest.json.sigstore.json",
        "SHA256SUMS",
      ].sort();
      assert.deepEqual(githubFiles, expectedGithubFiles);
      assert.equal(new Set(githubFiles).size, githubFiles.length);

      for (const spec of TARGET_SPECS) {
        const sourceMetadata = path.join(fixture.root, spec.targetId, "files", spec.metadataFile);
        const nativeMetadata = path.join(
          destination,
          "desktop",
          "beta",
          spec.platform,
          spec.arch,
          spec.metadataFile,
        );
        const githubMetadata = path.join(destination, "github-release", spec.releaseMetadataFile);
        assert.deepEqual(fs.readFileSync(nativeMetadata), fs.readFileSync(sourceMetadata));
        assert.deepEqual(fs.readFileSync(githubMetadata), fs.readFileSync(sourceMetadata));

        // 每个目标必须生成自己的平台 release/latest，不能只依赖旧全局 Beta Catalog。
        const platformCatalog = path.join(
          destination,
          "desktop",
          "beta",
          spec.platform,
          spec.arch,
          "catalog",
        );
        const platformRelease = JSON.parse(fs.readFileSync(
          path.join(platformCatalog, "releases", VERSION, "release.json"),
          "utf8",
        ));
        const platformLatest = JSON.parse(fs.readFileSync(
          path.join(platformCatalog, "latest.json"),
          "utf8",
        ));
        assert.equal(platformRelease.schemaVersion, 2);
        assert.equal(platformRelease.channel, "beta");
        assert.equal(platformRelease.sourceChannel, "beta");
        assert.equal(platformRelease.platform, spec.platform);
        assert.equal(platformRelease.arch, spec.arch);
        assert.equal(platformRelease.nativeMetadata, `desktop/beta/${spec.platform}/${spec.arch}/${spec.metadataFile}`);
        assert.deepEqual(platformLatest, {
          schemaVersion: 2,
          channel: "beta",
          platform: spec.platform,
          arch: spec.arch,
          version: VERSION,
          release: `desktop/beta/${spec.platform}/${spec.arch}/catalog/releases/${VERSION}/release.json`,
        });
      }

      const catalog = path.join(destination, "desktop", "beta", "catalog");
      const releaseRoot = path.join(catalog, "releases", VERSION);
      assert.deepEqual(fs.readdirSync(releaseRoot).sort(), [
        "release-manifest.json",
        "release-manifest.json.sigstore.json",
        "release.json",
        "SHA256SUMS",
      ].sort());
      const release = JSON.parse(fs.readFileSync(path.join(releaseRoot, "release.json"), "utf8"));
      assert.equal(release.targets.length, 5);
      const latest = JSON.parse(fs.readFileSync(path.join(catalog, "latest.json"), "utf8"));
      assert.equal(latest.release, `desktop/beta/catalog/releases/${VERSION}/release.json`);
      assert.doesNotMatch(JSON.stringify({ release, latest }), /desktop\/stable\//);
    } finally {
      removeTree(built.outputRoot);
      fs.rmSync(bundlePath, { force: true });
      removeTree(destination);
    }
  });
});

test("发布完成包拒绝 Sigstore bundle 缺失、符号链接或空文件", () => {
  withFiveTargets((fixture) => {
    const built = buildFixture(fixture, "bundle-invalid");
    const missing = path.join(fixtureParent, `missing-${process.pid}-${Date.now()}.sigstore.json`);
    const empty = path.join(fixtureParent, `empty-${process.pid}-${Date.now()}.sigstore.json`);
    const link = path.join(fixtureParent, `link-${process.pid}-${Date.now()}.sigstore.json`);
    const linkSource = path.join(fixtureParent, `link-source-${process.pid}-${Date.now()}`);
    const parentLinkSource = path.join(fixtureParent, `parent-link-source-${process.pid}-${Date.now()}`);
    const parentLink = path.join(fixtureParent, `parent-link-${process.pid}-${Date.now()}`);
    fs.writeFileSync(empty, "");
    fs.mkdirSync(linkSource);
    fs.symlinkSync(linkSource, link, "junction");
    fs.mkdirSync(parentLinkSource);
    const nestedBundle = createBundle(
      `nested-${process.pid}-${Date.now()}`,
      built.manifestPath,
    );
    fs.renameSync(nestedBundle, path.join(parentLinkSource, "bundle.sigstore.json"));
    fs.symlinkSync(parentLinkSource, parentLink, "junction");
    try {
      for (const [index, sigstoreBundlePath] of [
        missing,
        empty,
        link,
        path.join(parentLink, "bundle.sigstore.json"),
      ].entries()) {
        const destinationRoot = path.join(fixtureParent, `bundle-invalid-destination-${index}-${process.pid}-${Date.now()}`);
        try {
          assert.throws(() => prepareReleasePublication({
            targetsRoot: fixture.root,
            manifestPath: built.manifestPath,
            sha256SumsPath: built.sha256SumsPath,
            sigstoreBundlePath,
            destinationRoot,
          }), /Sigstore.*(?:缺失|符号链接|空文件|类型|路径)/);
          assert.equal(fs.existsSync(destinationRoot), false);
        } finally {
          removeTree(destinationRoot);
        }
      }
    } finally {
      removeTree(built.outputRoot);
      fs.rmSync(empty, { force: true });
      removeTree(link);
      removeTree(linkSource);
      removeTree(parentLink);
      removeTree(parentLinkSource);
    }
  });
});

test("发布完成包拒绝不足五目标、SHA 漏项、stable path 与 Tag/commit 不一致", () => {
  const cases = [
    {
      name: "missing-target",
      mutate(manifest: any, sums: string) {
        manifest.artifacts = manifest.artifacts.filter((item: any) => item.platform !== "linux" || item.arch !== "arm64");
        return { manifest, sums };
      },
      error: /五个|目标/,
    },
    {
      name: "missing-sum",
      mutate(manifest: any, sums: string) {
        return { manifest, sums: `${sums.trimEnd().split("\n").slice(0, -1).join("\n")}\n` };
      },
      error: /SHA256SUMS.*(?:漏项|一致|条目)/,
    },
    {
      name: "stable-path",
      mutate(manifest: any, sums: string) {
        manifest.artifacts[0].path = manifest.artifacts[0].path.replace("desktop/beta/", "desktop/stable/");
        return { manifest, sums };
      },
      error: /stable|beta|路径/,
    },
    {
      name: "tag",
      mutate(manifest: any, sums: string) {
        manifest.tag = "v1.1.10-beta.3";
        return { manifest, sums };
      },
      error: /Tag|版本/,
    },
    {
      name: "commit",
      mutate(manifest: any, sums: string) {
        manifest.commitSha = "f".repeat(40);
        return { manifest, sums };
      },
      error: /commit|Git SHA|Sigstore.*(?:digest|摘要)/,
    },
  ];
  for (const testCase of cases) {
    const fixture = createFiveTargets();
    const built = buildFixture(fixture, testCase.name);
    const bundlePath = createBundle(
      `${testCase.name}-${process.pid}-${Date.now()}`,
      built.manifestPath,
    );
    const manifest = JSON.parse(fs.readFileSync(built.manifestPath, "utf8"));
    const sums = fs.readFileSync(built.sha256SumsPath, "utf8");
    const mutated = testCase.mutate(manifest, sums);
    const manifestPath = path.join(built.outputRoot, `${testCase.name}-manifest.json`);
    const sumsPath = path.join(built.outputRoot, `${testCase.name}-SHA256SUMS`);
    fs.writeFileSync(manifestPath, `${JSON.stringify(mutated.manifest, null, 2)}\n`, "utf8");
    fs.writeFileSync(sumsPath, mutated.sums, "utf8");
    const destinationRoot = path.join(fixtureParent, `invalid-publication-${testCase.name}-${process.pid}-${Date.now()}`);
    try {
      assert.throws(() => prepareReleasePublication({
        targetsRoot: fixture.root,
        manifestPath,
        sha256SumsPath: sumsPath,
        sigstoreBundlePath: bundlePath,
        destinationRoot,
      }), testCase.error);
      assert.equal(fs.existsSync(destinationRoot), false);
    } finally {
      removeTree(fixture.root);
      removeTree(fixture.rawRoot);
      removeTree(built.outputRoot);
      fs.rmSync(bundlePath, { force: true });
      removeTree(destinationRoot);
    }
  }
});

test("发布完成包复制前复算全部 SHA-256 与大小", () => {
  withFiveTargets((fixture) => {
    const built = buildFixture(fixture, "tamper");
    const bundlePath = createBundle(`tamper-${process.pid}-${Date.now()}`, built.manifestPath);
    const destination = path.join(fixtureParent, `release-tamper-${process.pid}-${Date.now()}`);
    const setup = path.join(
      fixture.root,
      "windows-x64",
      "files",
      `天将漫创-${VERSION}-win-x64-setup.exe`,
    );
    const originalSetup = fs.readFileSync(setup);
    retryFixtureIo(() => fs.appendFileSync(setup, "tampered", "utf8"));
    const changedSetup = fs.readFileSync(setup);
    const metadataPath = path.join(fixture.root, "windows-x64", "files", "latest.yml");
    const changedMetadata = fs.readFileSync(metadataPath, "utf8")
      .replaceAll(sha512(originalSetup), sha512(changedSetup))
      .replace(`size: ${originalSetup.length}`, `size: ${changedSetup.length}`);
    // 保持 Task 2 SHA-512 硬门有效，只让 Task 3 索引 SHA-256/大小证据过期。
    fs.writeFileSync(metadataPath, changedMetadata, "utf8");
    try {
      assert.throws(() => prepareReleasePublication({
        targetsRoot: fixture.root,
        manifestPath: built.manifestPath,
        sha256SumsPath: built.sha256SumsPath,
        sigstoreBundlePath: bundlePath,
        destinationRoot: destination,
      }), /SHA-256|大小|索引/);
      assert.equal(fs.existsSync(destination), false);
    } finally {
      removeTree(built.outputRoot);
      fs.rmSync(bundlePath, { force: true });
      removeTree(destination);
    }
  });
});

test("发布完成包拒绝通过符号链接越界的发布根", () => {
  withFiveTargets((fixture) => {
    const built = buildFixture(fixture, "root-link");
    const bundlePath = createBundle(`root-link-${process.pid}-${Date.now()}`, built.manifestPath);
    const outside = path.join(fixtureParent, `release-outside-${process.pid}-${Date.now()}`);
    const destination = path.join(fixtureParent, `release-root-link-${process.pid}-${Date.now()}`);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, destination, "junction");
    try {
      assert.throws(() => prepareReleasePublication({
        targetsRoot: fixture.root,
        manifestPath: built.manifestPath,
        sha256SumsPath: built.sha256SumsPath,
        sigstoreBundlePath: bundlePath,
        destinationRoot: destination,
      }), /发布根|符号链接|越界/);
      assert.deepEqual(fs.readdirSync(outside), []);
    } finally {
      removeTree(built.outputRoot);
      fs.rmSync(bundlePath, { force: true });
      removeTree(destination);
      removeTree(outside);
    }
  });
});

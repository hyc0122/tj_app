import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// @ts-expect-error 发布脚本保持原生 ESM，由真实 Node 入口与测试共用。
import { assertUnversionedBucketStatus, publishReleaseTransaction } from "../../scripts/publish-release-transaction.mjs";

const fixtureParent = path.resolve(process.cwd(), "..", ".tmp", "remote-release-publication");
const latestKey = "desktop/beta/catalog/latest.json";
const metadataKeys = [
  "desktop/beta/windows/x64/latest.yml",
  "desktop/beta/macos/x64/latest-mac.yml",
  "desktop/beta/macos/arm64/latest-mac.yml",
  "desktop/beta/linux/x64/latest-linux.yml",
  "desktop/beta/linux/arm64/latest-linux.yml",
];
const platformLatestKeys = metadataKeys.map(
  (key) => `${path.posix.dirname(key)}/catalog/latest.json`,
);

type PutResult = "created" | "exists";

class FakeRemote {
  readonly objects = new Map<string, Buffer>();
  readonly calls: string[] = [];
  readonly writes: string[] = [];
  readonly atomicWrites: Array<{ key: string; bytes: Buffer }> = [];
  failAtomicKey?: string;
  failAtomicCount = 0;

  async assertImmutableUploadMode() {
    this.calls.push("assertImmutableUploadMode");
  }

  async readObject(key: string) {
    this.calls.push(`readObject:${key}`);
    const bytes = this.objects.get(key);
    return bytes ? Buffer.from(bytes) : null;
  }

  async putImmutable(key: string, bytes: Buffer): Promise<PutResult> {
    this.calls.push(`putImmutable:${key}`);
    if (this.objects.has(key)) return "exists";
    this.objects.set(key, Buffer.from(bytes));
    this.writes.push(`immutable:${key}`);
    return "created";
  }

  async putAtomic(key: string, bytes: Buffer) {
    this.calls.push(`putAtomic:${key}`);
    if (this.failAtomicKey === key && this.failAtomicCount > 0) {
      this.failAtomicCount -= 1;
      throw new Error("注入的平台指针写入失败");
    }
    this.objects.set(key, Buffer.from(bytes));
    this.writes.push(`atomic:${key}`);
    this.atomicWrites.push({ key, bytes: Buffer.from(bytes) });
  }

  async readPublicObject(key: string) {
    this.calls.push(`readPublicObject:${key}`);
    const bytes = this.objects.get(key);
    return bytes ? Buffer.from(bytes) : null;
  }

  async readPublicRange(key: string, start: number, end: number) {
    this.calls.push(`readPublicRange:${key}`);
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error("not found");
    const actualEnd = Math.min(end, bytes.length - 1);
    return {
      status: 206,
      contentRange: `bytes ${start}-${actualEnd}/${bytes.length}`,
      bytes: bytes.subarray(start, actualEnd + 1),
    };
  }
}

test("五平台发布严格先提交并公开校验全部不可变对象，再提交平台指针和总指针", async () => {
  const fixture = createPublicationFixture("1.2.0-beta.1");
  const remote = new FakeRemote();
  try {
    const result = await publishReleaseTransaction({
      publicationRoot: fixture.root,
      version: fixture.version,
      remote,
      singleWriterProof: fixture.singleWriterProof,
    });

    assert.deepEqual(result.events, [
      "catalog:current-frozen",
      "platform-catalog:windows-x64:current-frozen",
      "platform-catalog:macos-x64:current-frozen",
      "platform-catalog:macos-arm64:current-frozen",
      "platform-catalog:linux-x64:current-frozen",
      "platform-catalog:linux-arm64:current-frozen",
      "immutable:all-uploaded",
      "immutable:all-public-200-verified",
      "immutable:all-public-206-verified",
      "metadata:windows-x64",
      "metadata:macos-x64",
      "metadata:macos-arm64",
      "metadata:linux-x64",
      "metadata:linux-arm64",
      "platform-catalog:windows-x64:latest-published",
      "platform-catalog:windows-x64:latest-verified",
      "platform-catalog:macos-x64:latest-published",
      "platform-catalog:macos-x64:latest-verified",
      "platform-catalog:macos-arm64:latest-published",
      "platform-catalog:macos-arm64:latest-verified",
      "platform-catalog:linux-x64:latest-published",
      "platform-catalog:linux-x64:latest-verified",
      "platform-catalog:linux-arm64:latest-published",
      "platform-catalog:linux-arm64:latest-verified",
      "catalog:release-uploaded",
      "catalog:release-verified",
      "catalog:latest-condition-verified",
      "catalog:latest-published",
      "catalog:latest-verified",
    ]);
    assert.equal(result.version, fixture.version);

    const immutableWrites = remote.writes.filter((entry) => entry.startsWith("immutable:"));
    const atomicWrites = remote.writes.filter((entry) => entry.startsWith("atomic:"));
    assert.deepEqual(
      immutableWrites.map((entry) => entry.slice("immutable:".length)).sort(),
      [...fixture.immutableKeys].sort(),
    );
    assert.deepEqual(atomicWrites.map((entry) => entry.slice("atomic:".length)), [
      ...metadataKeys,
      ...platformLatestKeys,
      latestKey,
    ]);
    assert.ok(remote.writes.lastIndexOf(immutableWrites.at(-1)!) < remote.writes.indexOf(atomicWrites[0]));

    // 所有 200 校验必须完成后才能开始 206 校验，指针写入又必须晚于全部公开校验。
    const lastPublic200 = findLastIndex(remote.calls, "readPublicObject:");
    const firstPublic206 = remote.calls.findIndex((entry) => entry.startsWith("readPublicRange:"));
    const lastPublic206 = findLastIndex(remote.calls, "readPublicRange:");
    const firstPointerWrite = remote.calls.findIndex((entry) => entry.startsWith("putAtomic:"));
    assert.ok(lastPublic200 >= 0 && lastPublic200 < firstPublic206);
    assert.ok(lastPublic206 >= 0 && lastPublic206 < firstPointerWrite);
    assert.deepEqual(remote.objects.get(latestKey), fixture.bytesByKey.get(latestKey));
  } finally {
    removeTree(fixture.root);
  }
});

for (const [name, currentLatest, expectedError] of [
  [
    "Windows 目录不得接受声明为 macos/x64 的旧 latest",
    {
      schemaVersion: 2,
      channel: "beta",
      platform: "macos",
      arch: "x64",
      version: "1.1.10-beta.1",
      release: "desktop/beta/macos/x64/catalog/releases/1.1.10-beta.1/release.json",
    },
    /平台发布合同：latest 平台或架构不一致/,
  ],
  [
    "Windows 目录不得接受错误 schemaVersion 的旧 latest",
    {
      schemaVersion: 1,
      channel: "beta",
      platform: "windows",
      arch: "x64",
      version: "1.1.10-beta.1",
      release: "desktop/beta/windows/x64/catalog/releases/1.1.10-beta.1/release.json",
    },
    /平台发布合同：latest schemaVersion 必须为 2/,
  ],
  [
    "Windows 目录不得接受 rc 版本的旧 latest",
    {
      schemaVersion: 2,
      channel: "beta",
      platform: "windows",
      arch: "x64",
      version: "1.1.10-rc.1",
      release: "desktop/beta/windows/x64/catalog/releases/1.1.10-rc.1/release.json",
    },
    /平台发布合同：版本无效/,
  ],
  [
    "Windows 目录不得接受跨到 macos 的 release 路径",
    {
      schemaVersion: 2,
      channel: "beta",
      platform: "windows",
      arch: "x64",
      version: "1.1.10-beta.1",
      release: "desktop/beta/macos/x64/catalog/releases/1.1.10-beta.1/release.json",
    },
    /平台发布合同：release 路径无效/,
  ],
] as const) {
  test(name, async () => {
    const fixture = createPublicationFixture("1.2.0-beta.1");
    const remote = new FakeRemote();
    remote.objects.set(platformLatestKeys[0], jsonBytes(currentLatest));
    try {
      await assert.rejects(() => publishReleaseTransaction({
        publicationRoot: fixture.root,
        version: fixture.version,
        remote,
        singleWriterProof: fixture.singleWriterProof,
      }), expectedError);
      assert.deepEqual(remote.writes, [], "旧平台 latest 无效时不得发生任何远端写入");
    } finally {
      removeTree(fixture.root);
    }
  });
}

test("不可变对象已存在且逐字相同时同版本重跑保持幂等", async () => {
  const fixture = createPublicationFixture("1.2.0-beta.2");
  const remote = new FakeRemote();
  for (const key of fixture.immutableKeys) {
    remote.objects.set(key, Buffer.from(fixture.bytesByKey.get(key)!));
  }
  try {
    await publishReleaseTransaction({
      publicationRoot: fixture.root,
      version: fixture.version,
      remote,
      singleWriterProof: fixture.singleWriterProof,
    });
    assert.deepEqual(remote.writes.filter((entry) => entry.startsWith("immutable:")), []);
    assert.deepEqual(remote.writes.filter((entry) => entry.startsWith("atomic:")), [
      ...metadataKeys.map((key) => `atomic:${key}`),
      ...platformLatestKeys.map((key) => `atomic:${key}`),
      `atomic:${latestKey}`,
    ]);
  } finally {
    removeTree(fixture.root);
  }
});

test("不可变对象已存在但字节不同时立即报冲突且不推进任何指针", async () => {
  const fixture = createPublicationFixture("1.2.0-beta.3");
  const remote = new FakeRemote();
  const firstImmutableKey = [...fixture.immutableKeys].sort((left, right) => left.localeCompare(right, "en"))[0];
  remote.objects.set(firstImmutableKey, Buffer.from("conflicting-object"));
  try {
    await assert.rejects(() => publishReleaseTransaction({
      publicationRoot: fixture.root,
      version: fixture.version,
      remote,
      singleWriterProof: fixture.singleWriterProof,
    }), /不可变对象.*冲突/);
    assert.deepEqual(remote.writes, []);
    assert.equal(remote.objects.has(latestKey), false);
    assert.deepEqual(
      remote.calls.filter((entry) => entry.startsWith("putImmutable:")),
      [`putImmutable:${firstImmutableKey}`],
    );
  } finally {
    removeTree(fixture.root);
  }
});

test("平台指针中断后重跑会重放已成功同值指针并补齐剩余指针", async () => {
  const fixture = createPublicationFixture("1.2.0-beta.4");
  const remote = new FakeRemote();
  remote.failAtomicKey = metadataKeys[2];
  remote.failAtomicCount = 1;
  try {
    await assert.rejects(() => publishReleaseTransaction({
      publicationRoot: fixture.root,
      version: fixture.version,
      remote,
      singleWriterProof: fixture.singleWriterProof,
    }), /平台指针写入失败/);
    assert.equal(remote.objects.has(latestKey), false);
    assert.deepEqual(
      metadataKeys.map((key) => remote.objects.has(key)),
      [true, true, false, false, false],
    );
    assert.deepEqual(remote.atomicWrites.map((entry) => entry.key), metadataKeys.slice(0, 2));
    const firstRunPointerBytes = remote.atomicWrites.map((entry) => Buffer.from(entry.bytes));
    const immutableWriteCount = remote.writes.filter((entry) => entry.startsWith("immutable:")).length;

    const result = await publishReleaseTransaction({
      publicationRoot: fixture.root,
      version: fixture.version,
      remote,
      singleWriterProof: fixture.singleWriterProof,
    });
    assert.equal(result.events.at(-1), "catalog:latest-verified");
    assert.equal(remote.objects.has(latestKey), true);
    assert.ok(metadataKeys.every((key) => remote.objects.has(key)));
    assert.deepEqual(
      remote.atomicWrites.map((entry) => entry.key),
      [...metadataKeys.slice(0, 2), ...metadataKeys, ...platformLatestKeys, latestKey],
    );
    for (const [index, key] of metadataKeys.slice(0, 2).entries()) {
      const replays = remote.atomicWrites.filter((entry) => entry.key === key);
      assert.equal(replays.length, 2, `${key} 必须同值重放一次`);
      assert.deepEqual(replays[0].bytes, firstRunPointerBytes[index]);
      assert.deepEqual(replays[1].bytes, firstRunPointerBytes[index]);
    }
    assert.deepEqual(
      metadataKeys.map((key) => remote.atomicWrites.filter((entry) => entry.key === key).length),
      [2, 2, 1, 1, 1],
    );
    assert.equal(remote.atomicWrites.filter((entry) => entry.key === latestKey).length, 1);
    assert.equal(
      remote.writes.filter((entry) => entry.startsWith("immutable:")).length,
      immutableWriteCount,
    );
  } finally {
    removeTree(fixture.root);
  }
});

test("不可覆盖上传只接受 OSS 未配置版本控制的响应", () => {
  assert.doesNotThrow(() => assertUnversionedBucketStatus(undefined));
  assert.doesNotThrow(() => assertUnversionedBucketStatus(""));
  assert.throws(() => assertUnversionedBucketStatus("Enabled"), /版本控制/);
  assert.throws(() => assertUnversionedBucketStatus("Suspended"), /版本控制/);
  assert.throws(() => assertUnversionedBucketStatus("Unknown"), /无法确认/);
});

function createPublicationFixture(version: string) {
  const root = path.join(fixtureParent, `publication-${crypto.randomUUID()}`);
  const repository = "hyc0122/tianjiang-manchuang";
  const runId = "987654321";
  const targets = task3TargetSpecs(version);
  const bytesByKey = new Map<string, Buffer>();
  const releaseTargets = targets.map((item) => {
    const prefix = `desktop/beta/${item.platform}/${item.arch}`;
    const metadataPath = `${prefix}/${item.metadataFile}`;
    const metadataBytes = Buffer.from(`version: ${version}\npath: ${item.artifacts[0].fileName}\n`);
    bytesByKey.set(metadataPath, metadataBytes);
    return {
      targetId: item.targetId,
      platform: item.platform,
      arch: item.arch,
      nativeMetadata: metadataPath,
      artifacts: item.artifacts.map((artifact, index) => {
        const artifactPath = `${prefix}/${artifact.fileName}`;
        const artifactBytes = Buffer.from(`${item.targetId}:${index}:${artifact.fileName}\n`, "utf8");
        bytesByKey.set(artifactPath, artifactBytes);
        return {
          path: artifactPath,
          fileName: artifact.fileName,
          kind: artifact.kind,
          size: artifactBytes.length,
          sha256: sha256(artifactBytes),
        };
      }),
    };
  });
  for (const target of releaseTargets) {
    const platformRoot = `desktop/beta/${target.platform}/${target.arch}`;
    const platformReleaseKey = `${platformRoot}/catalog/releases/${version}/release.json`;
    bytesByKey.set(platformReleaseKey, jsonBytes({
      schemaVersion: 2,
      channel: "beta",
      sourceChannel: "beta",
      platform: target.platform,
      arch: target.arch,
      version,
      tag: `v${version}`,
      commitSha: "a".repeat(40),
      nativeMetadata: target.nativeMetadata,
      artifacts: target.artifacts,
    }));
    bytesByKey.set(`${platformRoot}/catalog/latest.json`, jsonBytes({
      schemaVersion: 2,
      channel: "beta",
      platform: target.platform,
      arch: target.arch,
      version,
      release: platformReleaseKey,
    }));
  }
  const releaseRoot = `desktop/beta/catalog/releases/${version}`;
  const releaseKey = `${releaseRoot}/release.json`;
  const releaseManifestKey = `${releaseRoot}/release-manifest.json`;
  const sumsKey = `${releaseRoot}/SHA256SUMS`;
  const sigstoreKey = `${releaseRoot}/release-manifest.json.sigstore.json`;
  bytesByKey.set(releaseKey, jsonBytes({
    schemaVersion: 1,
    version,
    tag: `v${version}`,
    channel: "beta",
    commitSha: "a".repeat(40),
    targets: releaseTargets,
  }));
  const manifestArtifacts = releaseTargets.flatMap((item) => [
    ...item.artifacts.map((artifact) => ({
      path: artifact.path,
      fileName: artifact.fileName,
      platform: item.platform,
      arch: item.arch,
      kind: artifact.kind,
      size: artifact.size,
      sha256: artifact.sha256,
    })),
    {
      path: item.nativeMetadata,
      fileName: path.posix.basename(item.nativeMetadata),
      platform: item.platform,
      arch: item.arch,
      kind: "metadata",
      size: bytesByKey.get(item.nativeMetadata)!.length,
      sha256: sha256(bytesByKey.get(item.nativeMetadata)!),
    },
  ]).sort((left, right) => left.path.localeCompare(right.path, "en"));
  const manifestBytes = jsonBytes({
    schemaVersion: 1,
    version,
    tag: `v${version}`,
    channel: "beta",
    commitSha: "a".repeat(40),
    repository,
    workflow: ".github/workflows/app-release.yml",
    runId,
    runAttempt: "1",
    generatedAt: "2026-08-02T00:00:00.000Z",
    artifacts: manifestArtifacts,
  });
  bytesByKey.set(releaseManifestKey, manifestBytes);
  bytesByKey.set(sumsKey, Buffer.from(
    `${manifestArtifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n")}\n`,
    "utf8",
  ));
  bytesByKey.set(sigstoreKey, jsonBytes({
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: { tlogEntries: [] },
    messageSignature: {
      messageDigest: {
        algorithm: "SHA2_256",
        digest: sha256Base64(manifestBytes),
      },
      signature: Buffer.from("offline-test-signature", "utf8").toString("base64"),
    },
  }));
  bytesByKey.set(latestKey, jsonBytes({
    schemaVersion: 1,
    version,
    channel: "beta",
    release: releaseKey,
  }));

  for (const [key, bytes] of bytesByKey) writeFile(root, key, bytes);
  return {
    root,
    version,
    singleWriterProof: `github-actions:${repository}:${runId}:beta`,
    bytesByKey,
    immutableKeys: [...bytesByKey.keys()].filter(
      (key) => !metadataKeys.includes(key) && !platformLatestKeys.includes(key) && key !== latestKey,
    ),
  };
}

function task3TargetSpecs(version: string) {
  return [
    {
      targetId: "windows-x64",
      platform: "windows",
      arch: "x64",
      metadataFile: "latest.yml",
      artifacts: [
        { fileName: `天将漫创-${version}-win-x64-setup.exe`, kind: "installer" },
        { fileName: `天将漫创-${version}-win-x64-setup.exe.blockmap`, kind: "blockmap" },
      ],
    },
    ...(["x64", "arm64"] as const).map((arch) => ({
      targetId: `macos-${arch}`,
      platform: "macos",
      arch,
      metadataFile: "latest-mac.yml",
      artifacts: [
        { fileName: `天将漫创-${version}-mac-${arch}.dmg`, kind: "disk-image" },
        { fileName: `天将漫创-${version}-mac-${arch}.zip`, kind: "archive" },
        { fileName: `天将漫创-${version}-mac-${arch}.zip.blockmap`, kind: "blockmap" },
      ],
    })),
    ...(["x64", "arm64"] as const).map((arch) => ({
      targetId: `linux-${arch}`,
      platform: "linux",
      arch,
      metadataFile: "latest-linux.yml",
      artifacts: [
        { fileName: `天将漫创-${version}-linux-${arch}.AppImage`, kind: "app-image" },
        { fileName: `天将漫创-${version}-linux-${arch}.AppImage.blockmap`, kind: "blockmap" },
      ],
    })),
  ];
}

function writeFile(root: string, key: string, bytes: Buffer) {
  const targetPath = path.join(root, ...key.split("/"));
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, bytes);
}

function jsonBytes(value: unknown) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha256Base64(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("base64");
}

function findLastIndex(values: string[], prefix: string) {
  return values.reduce((found, value, index) => value.startsWith(prefix) ? index : found, -1);
}

function removeTree(targetPath: string) {
  // Windows 可能在并行测试中短暂扫描刚写出的 EXE 夹具；Node 对根目录 EPERM 不会可靠套用 maxRetries。
  const retryableCodes = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);
  const waitState = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt <= 60; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code ?? "")
        : "";
      if (!retryableCodes.has(code) || attempt === 60) throw error;
      Atomics.wait(waitState, 0, 0, 250);
    }
  }
}

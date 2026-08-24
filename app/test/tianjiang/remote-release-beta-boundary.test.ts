import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// @ts-expect-error 发布脚本保持原生 ESM，由真实 Node 入口与测试共用。
import { createAliyunOssRemoteFromEnvironment, publishReleaseTransaction } from "../../scripts/publish-release-transaction.mjs";

const fixtureParent = path.resolve(process.cwd(), "..", ".tmp", "remote-release-beta-boundary");
const latestKey = "desktop/beta/catalog/latest.json";

class BoundaryRemote {
  readonly objects = new Map<string, Buffer>();
  readonly writes: string[] = [];
  readonly keys: string[] = [];
  readonly forbiddenCalls: string[] = [];

  async assertImmutableUploadMode() {}

  async readObject(key: string) {
    this.keys.push(key);
    const bytes = this.objects.get(key);
    return bytes ? Buffer.from(bytes) : null;
  }

  async putImmutable(key: string, bytes: Buffer) {
    this.keys.push(key);
    if (this.objects.has(key)) return "exists" as const;
    this.objects.set(key, Buffer.from(bytes));
    this.writes.push(key);
    return "created" as const;
  }

  async putAtomic(key: string, bytes: Buffer) {
    this.keys.push(key);
    this.objects.set(key, Buffer.from(bytes));
    this.writes.push(key);
  }

  async readPublicObject(key: string) {
    this.keys.push(key);
    const bytes = this.objects.get(key);
    return bytes ? Buffer.from(bytes) : null;
  }

  async readPublicRange(key: string, start: number, end: number) {
    this.keys.push(key);
    const bytes = this.objects.get(key)!;
    const actualEnd = Math.min(end, bytes.length - 1);
    return {
      status: 206,
      contentRange: `bytes ${start}-${actualEnd}/${bytes.length}`,
      bytes: bytes.subarray(start, actualEnd + 1),
    };
  }

  async delete() { this.forbiddenCalls.push("delete"); }
  async remove() { this.forbiddenCalls.push("remove"); }
  async createBucket() { this.forbiddenCalls.push("createBucket"); }
  async putBucketAcl() { this.forbiddenCalls.push("putBucketAcl"); }
  async setBucketPolicy() { this.forbiddenCalls.push("setBucketPolicy"); }
}

test("channel 非 beta、stable/catalog 越界和含双点 Key 均在远端写入前失败", async () => {
  const cases: Array<[string, (fixture: ReturnType<typeof createFixture>) => void, RegExp]> = [
    ["channel", (fixture) => mutateJson(fixture.releasePath, (record) => { record.channel = "stable"; }), /channel|beta/],
    ["stable", (fixture) => writeFile(fixture.root, "desktop/stable/forbidden.bin", Buffer.from("x")), /Beta 前缀|越过/],
    ["catalog", (fixture) => writeFile(fixture.root, "desktop/catalog/forbidden.json", Buffer.from("{}")), /Beta 前缀|越过/],
    ["double-dot", (fixture) => {
      const record = JSON.parse(fs.readFileSync(fixture.releasePath, "utf8"));
      const artifact = record.targets[0].artifacts[0];
      const oldPath = path.join(fixture.root, ...artifact.path.split("/"));
      artifact.path = artifact.path.replace(artifact.fileName, `bad..${artifact.fileName}`);
      const nextPath = path.join(fixture.root, ...artifact.path.split("/"));
      fs.renameSync(oldPath, nextPath);
      fs.writeFileSync(fixture.releasePath, jsonBytes(record));
    }, /Beta 前缀|越过/],
  ];

  for (const [name, mutate, expectedError] of cases) {
    const fixture = createFixture(name);
    const remote = new BoundaryRemote();
    try {
      mutate(fixture);
      await assert.rejects(() => publishFixture(fixture, remote), expectedError, name);
      assert.deepEqual(remote.writes, [], `${name} 不得产生远端写入`);
    } finally {
      removeTree(fixture.root);
    }
  }
});

test("x64-evil 与 arm64-evil 前缀碰撞不能冒充固定平台架构目录", async () => {
  for (const [name, targetIndex, evilArch] of [
    ["x64-prefix-collision", 0, "x64-evil"],
    ["arm64-prefix-collision", 4, "arm64-evil"],
  ] as const) {
    const fixture = createFixture(name);
    const remote = new BoundaryRemote();
    try {
      const release = JSON.parse(fs.readFileSync(fixture.releasePath, "utf8"));
      const artifact = release.targets[targetIndex].artifacts[0];
      const oldPath = path.join(fixture.root, ...artifact.path.split("/"));
      artifact.path = artifact.path.replace(`/${release.targets[targetIndex].arch}/`, `/${evilArch}/`);
      const nextPath = path.join(fixture.root, ...artifact.path.split("/"));
      fs.mkdirSync(path.dirname(nextPath), { recursive: true });
      fs.renameSync(oldPath, nextPath);
      fs.writeFileSync(fixture.releasePath, jsonBytes(release));

      await assert.rejects(
        () => publishFixture(fixture, remote),
        /release artifact 路径越过目标目录/,
        name,
      );
      assert.deepEqual(remote.writes, []);
    } finally {
      removeTree(fixture.root);
    }
  }
});

test("publicationRoot 或发布普通文件为符号链接时在远端写入前失败", async () => {
  const rootFixture = createFixture("root-link");
  const rootLink = path.join(fixtureParent, `root-link-${crypto.randomUUID()}`);
  fs.symlinkSync(rootFixture.root, rootLink, "junction");
  const rootRemote = new BoundaryRemote();
  try {
    await assert.rejects(() => publishReleaseTransaction({
      publicationRoot: rootLink,
      version: rootFixture.version,
      remote: rootRemote,
      singleWriterProof: rootFixture.singleWriterProof,
    }), /符号链接|类型无效/);
    assert.deepEqual(rootRemote.writes, []);
  } finally {
    removeTree(rootLink);
    removeTree(rootFixture.root);
  }

  const fileFixture = createFixture("file-link");
  const fileRemote = new BoundaryRemote();
  const artifactPath = fileFixture.artifactPaths[0];
  const sourcePath = `${artifactPath}.source`;
  const originalBytes = fs.readFileSync(artifactPath);
  fs.rmSync(artifactPath);
  fs.mkdirSync(sourcePath);
  fs.writeFileSync(path.join(sourcePath, "payload.bin"), originalBytes);
  // Windows 普通用户可创建 junction；放在普通文件槽位同样证明 loader 会拒绝符号链接。
  fs.symlinkSync(sourcePath, artifactPath, "junction");
  try {
    await assert.rejects(() => publishFixture(fileFixture, fileRemote), /符号链接|类型无效/);
    assert.deepEqual(fileRemote.writes, []);
  } finally {
    fs.rmSync(artifactPath, { force: true });
    removeTree(fileFixture.root);
  }
});

test("单写者证明必须逐字匹配 release manifest 的仓库、runId 和 beta", async () => {
  const fixture = createFixture("writer-proof");
  const remote = new BoundaryRemote();
  try {
    await assert.rejects(() => publishReleaseTransaction({
      publicationRoot: fixture.root,
      version: fixture.version,
      remote,
      singleWriterProof: "github-actions:other/project:1:beta",
    }), /单写者并发门/);
    assert.deepEqual(remote.writes, []);
  } finally {
    removeTree(fixture.root);
  }
});

test("loader 逐字复核 Task 3 manifest、SHA256SUMS、Sigstore digest 与 metadata", async () => {
  const cases: Array<[string, (fixture: ReturnType<typeof createFixture>) => void, RegExp]> = [
    ["manifest-artifacts", (fixture) => {
      const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8"));
      manifest.artifacts.pop();
      fs.writeFileSync(fixture.manifestPath, jsonBytes(manifest));
      rewriteSumsAndSigstore(fixture);
    }, /ReleaseManifest|manifest.*artifact|一一对应/],
    ["sha256sums", (fixture) => {
      fs.writeFileSync(fixture.sumsPath, "test-only\n", "utf8");
    }, /SHA256SUMS/],
    ["sigstore-structure", (fixture) => {
      fs.writeFileSync(fixture.sigstorePath, jsonBytes({ bundle: "test-only" }));
    }, /Sigstore bundle 结构/],
    ["sigstore-digest", (fixture) => {
      const bundle = JSON.parse(fs.readFileSync(fixture.sigstorePath, "utf8"));
      bundle.messageSignature.messageDigest.digest = Buffer.from("wrong-digest", "utf8").toString("base64");
      fs.writeFileSync(fixture.sigstorePath, jsonBytes(bundle));
    }, /Sigstore.*digest/],
    ["metadata-drift", (fixture) => {
      fs.appendFileSync(fixture.metadataPaths[0], "drift: true\n", "utf8");
    }, /ReleaseManifest|metadata|一一对应|SHA-256/],
  ];

  for (const [name, mutate, expectedError] of cases) {
    const fixture = createFixture(name);
    const remote = new BoundaryRemote();
    try {
      mutate(fixture);
      await assert.rejects(() => publishFixture(fixture, remote), expectedError, name);
      assert.deepEqual(remote.writes, [], `${name} 必须在任何远端写入前失败`);
    } finally {
      removeTree(fixture.root);
    }
  }
});

test("成功事务只访问 desktop/beta allowlist 且不调用删除、建桶或权限方法", async () => {
  const fixture = createFixture("allowlist");
  const remote = new BoundaryRemote();
  try {
    await publishFixture(fixture, remote);
    assert.ok(remote.keys.length > 0);
    assert.ok(remote.keys.every((key) => key.startsWith("desktop/beta/") && !key.includes("..")));
    assert.deepEqual(remote.forbiddenCalls, []);
    assert.equal(remote.objects.has(latestKey), true);
  } finally {
    removeTree(fixture.root);
  }
});

test("OSS Region 与 Endpoint 必须在 SDK client 创建前固定为青岛 HTTPS 地址", async () => {
  const baseEnvironment = fakeEnvironment();
  let sdkLoadCount = 0;
  const dependencies = {
    loadOss: async () => {
      sdkLoadCount += 1;
      throw new Error("无效配置不得加载 SDK");
    },
  };
  for (const [name, environment, expected] of [
    ["region", { ...baseEnvironment, OSS_REGION: "oss-cn-hangzhou" }, /Region/],
    ["endpoint", { ...baseEnvironment, OSS_ENDPOINT: "https://oss-cn-hangzhou.aliyuncs.com" }, /Endpoint/],
  ] as const) {
    await assert.rejects(
      () => createAliyunOssRemoteFromEnvironment(environment, dependencies),
      (error: Error) => {
        assert.match(error.message, expected, name);
        assert.doesNotMatch(error.message, /fake-access|example-beta-bucket/);
        assert.doesNotMatch(error.message, /https?:\/\//, "配置错误不得回显 endpoint");
        return true;
      },
    );
  }
  assert.equal(sdkLoadCount, 0);
});

test("OSS 适配器缺少外部配置时不接触网络且只报告变量名", async () => {
  await assert.rejects(
    () => createAliyunOssRemoteFromEnvironment({}),
    (error: Error) => {
      assert.match(error.message, /OSS_ACCESS_KEY_ID/);
      assert.match(error.message, /OSS_REGION/);
      assert.doesNotMatch(error.message, /AccessKeySecret|LTAI/);
      return true;
    },
  );
});

test("正式 Aliyun OSS 适配器通过 mock SDK/fetch 离线完成完整事务", async () => {
  const fixture = createFixture("offline-adapter-success");
  const remoteObjects = new Map<string, Buffer>();
  const clientConfigs: Array<Record<string, unknown>> = [];
  const sdkCalls: string[] = [];
  const putCalls: Array<{ key: string; headers: Record<string, string> }> = [];
  const fetchCalls: Array<{ key: string; range: string | null }> = [];

  class FakeOssClient {
    constructor(config: Record<string, unknown>) {
      clientConfigs.push({ ...config });
    }

    async getBucketVersioning(bucket: string) {
      sdkCalls.push(`getBucketVersioning:${bucket}`);
      return { versionStatus: "" };
    }

    async get(key: string) {
      sdkCalls.push(`get:${key}`);
      const bytes = remoteObjects.get(key);
      if (!bytes) {
        const error = new Error("not found") as Error & { status: number; code: string };
        error.status = 404;
        error.code = "NoSuchKey";
        throw error;
      }
      return { content: Buffer.from(bytes) };
    }

    async put(key: string, bytes: Buffer, options: { headers: Record<string, string> }) {
      sdkCalls.push(`put:${key}`);
      putCalls.push({ key, headers: { ...options.headers } });
      if (options.headers["x-oss-forbid-overwrite"] === "true" && remoteObjects.has(key)) {
        const error = new Error("exists") as Error & { status: number; code: string };
        error.status = 409;
        error.code = "FileAlreadyExists";
        throw error;
      }
      remoteObjects.set(key, Buffer.from(bytes));
      return { name: key };
    }
  }

  const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const key = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const range = new Headers(init?.headers).get("Range");
    fetchCalls.push({ key, range });
    const bytes = remoteObjects.get(key);
    if (!bytes) return new Response(null, { status: 404 });
    if (range) {
      const matched = /^bytes=(\d+)-(\d+)$/.exec(range);
      assert.ok(matched);
      const start = Number(matched[1]);
      const end = Math.min(Number(matched[2]), bytes.length - 1);
      return new Response(Uint8Array.from(bytes.subarray(start, end + 1)), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${bytes.length}` },
      });
    }
    return new Response(Uint8Array.from(bytes), {
      status: 200,
      headers: { "content-length": String(bytes.length) },
    });
  };

  try {
    const remote = await createAliyunOssRemoteFromEnvironment(fakeEnvironment(), {
      loadOss: async () => ({ default: FakeOssClient }),
      fetch: fetchMock,
    });
    const result = await publishReleaseTransaction({
      publicationRoot: fixture.root,
      version: fixture.version,
      remote,
      singleWriterProof: fixture.singleWriterProof,
    });

    assert.equal(result.events.at(-1), "catalog:latest-verified");
    assert.equal(clientConfigs.length, 1);
    assert.equal(clientConfigs[0].region, "oss-cn-qingdao");
    assert.equal(clientConfigs[0].endpoint, "https://oss-cn-qingdao.aliyuncs.com");
    assert.ok(sdkCalls[0].startsWith("getBucketVersioning:"));
    assert.ok(putCalls.length > 0);
    assert.ok(putCalls.every((call) => call.key.startsWith("desktop/beta/") && !call.key.includes("..")));
    assert.ok(putCalls.some((call) => call.headers["x-oss-forbid-overwrite"] === "true"));
    assert.ok(putCalls.some((call) => call.key === latestKey && call.headers["x-oss-forbid-overwrite"] === undefined));
    assert.ok(fetchCalls.some((call) => call.range === null));
    assert.ok(fetchCalls.some((call) => call.range?.startsWith("bytes=") === true));
    assert.deepEqual(remoteObjects.get(latestKey), fs.readFileSync(path.join(fixture.root, ...latestKey.split("/"))));
    assert.ok(sdkCalls.every((call) => !/delete|remove|create|Acl|Policy/i.test(call)));
  } finally {
    removeTree(fixture.root);
  }
});

function createFixture(name: string) {
  const version = "1.1.10-beta.1";
  const repository = "hyc0122/tianjiang-manchuang";
  const runId = "123456789";
  const commitSha = "b".repeat(40);
  const root = path.join(fixtureParent, `${name}-${crypto.randomUUID()}`);
  const releaseRoot = `desktop/beta/catalog/releases/${version}`;
  const targets = task3TargetSpecs(version).map((spec) => {
    const prefix = `desktop/beta/${spec.platform}/${spec.arch}`;
    const metadataKey = `${prefix}/${spec.metadataFile}`;
    const metadataBytes = Buffer.from(`version: ${version}\npath: ${spec.artifacts[0].fileName}\n`, "utf8");
    writeFile(root, metadataKey, metadataBytes);
    return {
      targetId: spec.targetId,
      platform: spec.platform,
      arch: spec.arch,
      nativeMetadata: metadataKey,
      artifacts: spec.artifacts.map((artifact, index) => {
        const artifactKey = `${prefix}/${artifact.fileName}`;
        const artifactBytes = Buffer.from(`${spec.targetId}:${index}:${artifact.fileName}\n`, "utf8");
        writeFile(root, artifactKey, artifactBytes);
        return {
          path: artifactKey,
          fileName: artifact.fileName,
          kind: artifact.kind,
          size: artifactBytes.length,
          sha256: sha256(artifactBytes),
        };
      }),
    };
  });
  for (const target of targets) {
    const platformRoot = `desktop/beta/${target.platform}/${target.arch}`;
    const platformReleaseKey = `${platformRoot}/catalog/releases/${version}/release.json`;
    writeFile(root, platformReleaseKey, jsonBytes({
      schemaVersion: 2,
      channel: "beta",
      sourceChannel: "beta",
      platform: target.platform,
      arch: target.arch,
      version,
      tag: `v${version}`,
      commitSha,
      nativeMetadata: target.nativeMetadata,
      artifacts: target.artifacts,
    }));
    writeFile(root, `${platformRoot}/catalog/latest.json`, jsonBytes({
      schemaVersion: 2,
      channel: "beta",
      platform: target.platform,
      arch: target.arch,
      version,
      release: platformReleaseKey,
    }));
  }
  const releaseKey = `${releaseRoot}/release.json`;
  const releasePath = path.join(root, ...releaseKey.split("/"));
  writeFile(root, releaseKey, jsonBytes({
    schemaVersion: 1,
    version,
    tag: `v${version}`,
    channel: "beta",
    commitSha,
    targets,
  }));

  const manifestArtifacts = targets.flatMap((item) => [
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
      size: fs.statSync(path.join(root, ...item.nativeMetadata.split("/"))).size,
      sha256: sha256(fs.readFileSync(path.join(root, ...item.nativeMetadata.split("/")))),
    },
  ]).sort((left, right) => left.path.localeCompare(right.path, "en"));
  const manifestPath = path.join(root, ...`${releaseRoot}/release-manifest.json`.split("/"));
  const manifestBytes = jsonBytes({
    schemaVersion: 1,
    version,
    tag: `v${version}`,
    channel: "beta",
    commitSha,
    repository,
    workflow: ".github/workflows/app-release.yml",
    runId,
    runAttempt: "2",
    generatedAt: "2026-08-02T00:00:00.000Z",
    artifacts: manifestArtifacts,
  });
  writeFile(root, `${releaseRoot}/release-manifest.json`, manifestBytes);
  const sumsPath = path.join(root, ...`${releaseRoot}/SHA256SUMS`.split("/"));
  writeFile(root, `${releaseRoot}/SHA256SUMS`, Buffer.from(
    `${manifestArtifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n")}\n`,
    "utf8",
  ));
  const sigstorePath = path.join(root, ...`${releaseRoot}/release-manifest.json.sigstore.json`.split("/"));
  writeFile(root, `${releaseRoot}/release-manifest.json.sigstore.json`, sigstoreBytes(manifestBytes));
  writeFile(root, latestKey, jsonBytes({ schemaVersion: 1, version, channel: "beta", release: releaseKey }));
  return {
    root,
    version,
    releasePath,
    manifestPath,
    sumsPath,
    sigstorePath,
    metadataPaths: targets.map((item) => path.join(root, ...item.nativeMetadata.split("/"))),
    artifactPaths: targets.flatMap((item) => item.artifacts.map((artifact) => path.join(root, ...artifact.path.split("/")))),
    singleWriterProof: `github-actions:${repository}:${runId}:beta`,
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

function fakeEnvironment() {
  return {
    OSS_ACCESS_KEY_ID: "fake-access-id-for-test",
    OSS_ACCESS_KEY_SECRET: "fake-access-secret-for-test",
    OSS_REGION: "oss-cn-qingdao",
    OSS_BUCKET: "example-beta-bucket",
    OSS_ENDPOINT: "https://oss-cn-qingdao.aliyuncs.com",
    TIANJIANG_RELEASE_PUBLIC_BASE_URL: "https://downloads.example.test/",
  };
}

function rewriteSumsAndSigstore(fixture: ReturnType<typeof createFixture>) {
  const manifestBytes = fs.readFileSync(fixture.manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  fs.writeFileSync(
    fixture.sumsPath,
    `${manifest.artifacts.map((artifact: any) => `${artifact.sha256}  ${artifact.path}`).join("\n")}\n`,
    "utf8",
  );
  fs.writeFileSync(fixture.sigstorePath, sigstoreBytes(manifestBytes));
}

function sigstoreBytes(manifestBytes: Buffer) {
  return jsonBytes({
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: { tlogEntries: [] },
    messageSignature: {
      messageDigest: {
        algorithm: "SHA2_256",
        digest: crypto.createHash("sha256").update(manifestBytes).digest("base64"),
      },
      signature: Buffer.from("offline-test-signature", "utf8").toString("base64"),
    },
  });
}

function publishFixture(fixture: ReturnType<typeof createFixture>, remote: unknown) {
  return publishReleaseTransaction({
    publicationRoot: fixture.root,
    version: fixture.version,
    remote,
    singleWriterProof: fixture.singleWriterProof,
  });
}

function mutateJson(filePath: string, mutate: (record: any) => void) {
  const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
  mutate(record);
  fs.writeFileSync(filePath, jsonBytes(record));
}

function writeFile(root: string, key: string, bytes: Buffer) {
  const targetPath = path.join(root, ...key.split("/"));
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, bytes);
}

function jsonBytes(value: unknown) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes: Buffer) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function retryFixtureIo<T>(action: () => T): T {
  // Windows 杀毒或索引器可能短暂占用刚读取的夹具，有限重试只用于测试清理。
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

function removeTree(targetPath: string) {
  retryFixtureIo(() => fs.rmSync(targetPath, { recursive: true, force: true }));
}

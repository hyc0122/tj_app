import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  createPlatformOssRemoteFromEnvironment,
  publishStableWindowsTransaction,
} from "../../scripts/publish-platform-release-transaction.mjs";

const VERSION = "1.1.11";
const fixtureParent = path.resolve(process.cwd(), "..", ".tmp", "remote-stable-windows-release");
const stableLatestKey = "desktop/stable/windows/x64/catalog/latest.json";
const betaLatestKey = "desktop/beta/windows/x64/catalog/latest.json";
const stableMetadataKey = "desktop/stable/windows/x64/latest.yml";
const betaMetadataKey = "desktop/beta/windows/x64/latest.yml";

type PutResult = "created" | "exists";

class RecordingRemote {
  readonly objects = new Map<string, Buffer>();
  readonly keys: string[] = [];
  readonly events: string[] = [];
  readonly writes: string[] = [];
  readonly deleted: string[] = [];
  rangeStatus = 206;
  corruptPublicKey?: string;
  mutateOnSecondReadKey?: string;
  failAtomicKey?: string;
  failAtomicCount = 0;
  mutateOnReadKey?: string;
  mutateOnReadNumber = 0;
  mutateOnReadBytes?: Buffer;
  throwEpipeOnExistingImmutablePut = false;
  private readonly reads = new Map<string, number>();

  constructor({ stableVersion, betaVersion }: { stableVersion?: string; betaVersion?: string }) {
    if (stableVersion) this.objects.set(stableLatestKey, latestBytes("stable", stableVersion));
    if (betaVersion) this.objects.set(betaLatestKey, latestBytes("beta", betaVersion));
  }

  async assertImmutableUploadMode() {
    this.keys.push("$assertImmutableUploadMode");
  }

  async readObject(key: string) {
    this.keys.push(key);
    const count = (this.reads.get(key) ?? 0) + 1;
    this.reads.set(key, count);
    if (this.mutateOnSecondReadKey === key && count === 2) {
      this.objects.set(key, Buffer.from(`${this.objects.get(key)?.toString("utf8")} `, "utf8"));
    }
    const bytes = this.objects.get(key);
    return bytes ? Buffer.from(bytes) : null;
  }

  async readMutable(key: string) {
    this.keys.push(`readMutable:${key}`);
    this.events.push(`mutable-read:${key}`);
    const count = (this.reads.get(key) ?? 0) + 1;
    this.reads.set(key, count);
    if (this.mutateOnSecondReadKey === key && count === 2) {
      this.objects.set(key, Buffer.from(`${this.objects.get(key)?.toString("utf8")} `, "utf8"));
    }
    if (this.mutateOnReadKey === key && count === this.mutateOnReadNumber) {
      assert.ok(this.mutateOnReadBytes);
      this.objects.set(key, Buffer.from(this.mutateOnReadBytes));
    }
    const bytes = this.objects.get(key);
    return { bytes: bytes ? Buffer.from(bytes) : null };
  }

  async putImmutable(key: string, bytes: Buffer): Promise<PutResult> {
    this.keys.push(key);
    this.events.push(`immutable-put:${key}`);
    if (this.objects.has(key)) {
      if (this.throwEpipeOnExistingImmutablePut) {
        const error = new Error("write EPIPE") as Error & { code: string };
        error.code = "EPIPE";
        throw error;
      }
      return "exists";
    }
    this.objects.set(key, Buffer.from(bytes));
    this.writes.push(`immutable:${key}`);
    return "created";
  }

  async putAtomic(key: string, bytes: Buffer) {
    this.keys.push(key);
    if (this.failAtomicKey === key && this.failAtomicCount > 0) {
      this.failAtomicCount -= 1;
      throw new Error("注入的指针写入中断");
    }
    this.objects.set(key, Buffer.from(bytes));
    this.writes.push(`atomic:${key}`);
    this.events.push(`mutable-put:${key}`);
  }

  async readPublicObject(key: string) {
    this.keys.push(key);
    this.events.push(`public-200:${key}`);
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    const publicBytes = this.corruptPublicKey === key
      ? Buffer.from(`${bytes.toString("utf8")}corrupt`, "utf8")
      : bytes;
    return { size: publicBytes.length, sha256: sha256(publicBytes) };
  }

  async readPublicRange(key: string, start: number, end: number) {
    this.keys.push(key);
    this.events.push(`public-206:${key}`);
    const bytes = this.objects.get(key);
    assert.ok(bytes);
    const actualEnd = Math.min(end, bytes.length - 1);
    return {
      status: this.rangeStatus,
      contentRange: `bytes ${start}-${actualEnd}/${bytes.length}`,
      bytes: bytes.subarray(start, actualEnd + 1),
    };
  }
}

test("Stable 完成全部公开 200/206 校验后才写 native metadata/latest，并在版本更高时晋升 Beta", async () => {
  const fixture = createPublicationFixture("promotion");
  const remote = new RecordingRemote({ stableVersion: "1.1.10", betaVersion: "1.1.10-beta.14" });
  try {
    const result = await publishFixture(fixture, remote);
    assert.deepEqual(result.channels, ["stable", "beta"]);
    assert.equal(remote.deleted.length, 0);
    assert.equal(remote.keys.some((key) => /macos|linux/.test(key)), false);
    assert.equal(remote.keys.includes("desktop/beta/catalog/latest.json"), false);
    assert.deepEqual(remote.objects.get(stableLatestKey), fixture.bytesByKey.get(stableLatestKey));
    assert.deepEqual(remote.objects.get(betaLatestKey), fixture.bytesByKey.get(betaLatestKey));

    const lastPublicCheck = Math.max(
      findLastIndex(remote.events, "public-200:"),
      findLastIndex(remote.events, "public-206:"),
    );
    const firstMutableWrite = remote.events.findIndex((event) => event.startsWith("mutable-put:"));
    assert.ok(lastPublicCheck >= 0 && firstMutableWrite > lastPublicCheck);
    assert.deepEqual(
      remote.writes.filter((item) => item.startsWith("atomic:")).map((item) => item.slice("atomic:".length)),
      [stableMetadataKey, betaMetadataKey, stableLatestKey, betaLatestKey],
    );
  } finally {
    removeTree(fixture.root);
  }
});

test("Stable 低于 Beta 时不推进 Beta Windows", async () => {
  const fixture = createPublicationFixture("beta-newer");
  const remote = new RecordingRemote({ stableVersion: "1.1.10", betaVersion: "1.1.12-beta.1" });
  try {
    const result = await publishFixture(fixture, remote);
    assert.deepEqual(result.channels, ["stable"]);
    assert.equal(remote.writes.some((item) => item.includes("desktop/beta/windows/x64/")), false);
    assert.deepEqual(remote.objects.get(betaLatestKey), latestBytes("beta", "1.1.12-beta.1"));
  } finally {
    removeTree(fixture.root);
  }
});

test("Beta 同版本 latest 一致但 native metadata 异内容时在任何可变写前拒绝", async () => {
  const fixture = createPublicationFixture("beta-equal-metadata-conflict");
  const remote = new RecordingRemote({ stableVersion: "1.1.10", betaVersion: VERSION });
  seedChannelImmutableObjects(remote, fixture, "beta");
  remote.objects.set(betaMetadataKey, Buffer.from([
    "version: 1.1.11",
    "path: beta-conflicting-setup.exe",
    "",
  ].join("\n"), "utf8"));
  try {
    await assert.rejects(() => publishFixture(fixture, remote), /Beta.*metadata.*同版本|Beta.*内容冲突/i);
    assert.equal(remote.writes.some((item) => item.startsWith("atomic:")), false);
  } finally {
    removeTree(fixture.root);
  }
});

for (const [name, metadataBytes] of [
  ["缺失", null],
  ["较旧", Buffer.from("version: 1.1.10\npath: beta-older-setup.exe\n", "utf8")],
] as const) {
  test(`Beta 同版本只验证时 native metadata ${name}必须在任何可变写前拒绝`, async () => {
    const fixture = createPublicationFixture(`beta-equal-metadata-${name}`);
    const remote = new RecordingRemote({ stableVersion: "1.1.10", betaVersion: VERSION });
    seedChannelImmutableObjects(remote, fixture, "beta");
    if (metadataBytes !== null) remote.objects.set(betaMetadataKey, Buffer.from(metadataBytes));
    try {
      await assert.rejects(() => publishFixture(fixture, remote), /Beta.*metadata.*(缺失|逐字|一致|身份)/i);
      assert.equal(remote.writes.some((item) => item.startsWith("atomic:")), false);
    } finally {
      removeTree(fixture.root);
    }
  });
}

test("Beta 同版本 latest 和 metadata 一致但不可变对象异内容时在任何可变写前拒绝", async () => {
  const fixture = createPublicationFixture("beta-equal-immutable-conflict");
  const remote = new RecordingRemote({ stableVersion: "1.1.10", betaVersion: VERSION });
  seedChannelImmutableObjects(remote, fixture, "beta");
  remote.objects.set(betaMetadataKey, Buffer.from(fixture.bytesByKey.get(betaMetadataKey)!));
  const conflictingKey = "desktop/beta/windows/x64/天将漫创-1.1.11-win-x64-setup.exe";
  remote.objects.set(conflictingKey, Buffer.from("beta-immutable-conflict\n", "utf8"));
  try {
    await assert.rejects(() => publishFixture(fixture, remote), /不可变对象.*冲突/);
    assert.equal(remote.writes.some((item) => item.startsWith("atomic:")), false);
  } finally {
    removeTree(fixture.root);
  }
});

test("Beta 同版本完整身份一致时只验证全部公开对象而不推进 Beta", async () => {
  const fixture = createPublicationFixture("beta-equal-verify-only");
  const remote = new RecordingRemote({ stableVersion: "1.1.10", betaVersion: VERSION });
  seedChannelImmutableObjects(remote, fixture, "beta");
  remote.objects.set(betaMetadataKey, Buffer.from(fixture.bytesByKey.get(betaMetadataKey)!));
  const betaImmutableKeys = fixture.immutableKeys.filter((key) => key.startsWith("desktop/beta/windows/x64/"));
  try {
    const result = await publishFixture(fixture, remote);
    assert.deepEqual(result.channels, ["stable"]);
    assert.equal(remote.writes.some((item) => item.startsWith("atomic:desktop/beta/windows/x64/")), false);
    for (const key of betaImmutableKeys) {
      assert.equal(remote.events.includes(`public-200:${key}`), true);
      assert.equal(remote.events.includes(`public-206:${key}`), true);
    }
  } finally {
    removeTree(fixture.root);
  }
});

test("Stable 平台指针拒绝版本倒退", async () => {
  const fixture = createPublicationFixture("stable-downgrade");
  const remote = new RecordingRemote({ stableVersion: "1.1.12", betaVersion: "1.1.10-beta.1" });
  try {
    await assert.rejects(() => publishFixture(fixture, remote), /Stable.*倒退|较旧版本|降级/);
    assert.deepEqual(remote.writes, []);
  } finally {
    removeTree(fixture.root);
  }
});

test("同版本平台指针只有逐字相同时才幂等", async () => {
  const fixture = createPublicationFixture("same-version");
  const identical = new RecordingRemote({ stableVersion: VERSION, betaVersion: "1.1.10-beta.1" });
  identical.objects.set(stableLatestKey, Buffer.from(fixture.bytesByKey.get(stableLatestKey)!));
  const conflicting = new RecordingRemote({ stableVersion: VERSION, betaVersion: "1.1.10-beta.1" });
  conflicting.objects.set(stableLatestKey, jsonBytes({
    ...JSON.parse(fixture.bytesByKey.get(stableLatestKey)!.toString("utf8")),
    conflict: true,
  }));
  try {
    const result = await publishFixture(fixture, identical);
    assert.deepEqual(result.channels, ["stable", "beta"]);
    await assert.rejects(() => publishFixture(fixture, conflicting), /同版本.*内容冲突/);
    assert.deepEqual(conflicting.writes, []);
  } finally {
    removeTree(fixture.root);
  }
});

test("native metadata 拒绝版本倒退和同版本异内容", async () => {
  for (const [name, currentBytes, expected] of [
    ["metadata-downgrade", Buffer.from("version: 1.1.12\npath: newer.exe\n", "utf8"), /metadata.*倒退|较旧版本|降级/i],
    ["metadata-same-version-conflict", Buffer.from(`version: ${VERSION}\npath: conflicting.exe\n`, "utf8"), /metadata.*同版本|内容冲突/i],
  ] as const) {
    const fixture = createPublicationFixture(name);
    const remote = new RecordingRemote({ stableVersion: "1.1.10", betaVersion: "1.1.10-beta.1" });
    remote.objects.set(stableMetadataKey, currentBytes);
    try {
      await assert.rejects(() => publishFixture(fixture, remote), expected);
      assert.deepEqual(remote.writes, []);
    } finally {
      removeTree(fixture.root);
    }
  }
});

test("native metadata 与平台 latest 均在写前精确复核并用普通原子 PutObject", async () => {
  const fixture = createPublicationFixture("mutable-double-check");
  const remote = new RecordingRemote({ stableVersion: "1.1.10", betaVersion: "1.1.10-beta.1" });
  try {
    await publishFixture(fixture, remote);
    assert.deepEqual(
      remote.writes.filter((item) => item.startsWith("atomic:")).map((item) => item.slice("atomic:".length)),
      [stableMetadataKey, betaMetadataKey, stableLatestKey, betaLatestKey],
    );
    for (const key of [stableMetadataKey, betaMetadataKey, stableLatestKey, betaLatestKey]) {
      const putIndex = remote.events.indexOf(`mutable-put:${key}`);
      assert.ok(putIndex > 0);
      assert.equal(remote.events[putIndex - 1], `mutable-read:${key}`);
    }
  } finally {
    removeTree(fixture.root);
  }
});

test("每个可变对象最后写前回读发现漂移时不调用 PutObject", async () => {
  const fixture = createPublicationFixture("latest-prewrite-drift");
  const remote = new RecordingRemote({ stableVersion: "1.1.10", betaVersion: "1.1.10-beta.1" });
  const winner = latestBytes("stable", "1.1.12");
  remote.mutateOnReadKey = stableLatestKey;
  remote.mutateOnReadNumber = 3;
  remote.mutateOnReadBytes = winner;
  try {
    await assert.rejects(() => publishFixture(fixture, remote), /写前|事务期间发生变化|漂移|并发/);
    assert.deepEqual(remote.objects.get(stableLatestKey), winner);
    assert.equal(remote.writes.some((item) => item.endsWith(stableLatestKey)), false);
  } finally {
    removeTree(fixture.root);
  }
});

test("OSS 公开 200 与 206 使用有界流式读取且不调用 arrayBuffer", async () => {
  const payload = Buffer.alloc(4096, 0x5a);
  const rangeBytes = payload.subarray(0, 1024);
  const fetchMock = async (_input: string | URL | Request, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("Range");
    const bytes = range ? rangeBytes : payload;
    const chunks = [bytes.subarray(0, Math.floor(bytes.length / 2)), bytes.subarray(Math.floor(bytes.length / 2))];
    return {
      status: range ? 206 : 200,
      headers: new Headers({
        "content-length": String(bytes.length),
        ...(range ? { "content-range": `bytes 0-${bytes.length - 1}/${payload.length}` } : {}),
      }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      arrayBuffer() {
        throw new Error("测试禁止整包 arrayBuffer");
      },
    };
  };
  class FakeOssClient {}
  const remote = await createPlatformOssRemoteFromEnvironment(fakeEnvironment(), {
    loadOss: async () => ({ default: FakeOssClient }),
    fetch: fetchMock,
  });

  const full = await remote.readPublicObject(
    "desktop/stable/windows/x64/fixture.exe",
    payload.length,
    sha256(payload),
  );
  assert.deepEqual(full, { size: payload.length, sha256: sha256(payload) });
  const range = await remote.readPublicRange(
    "desktop/stable/windows/x64/fixture.exe",
    0,
    rangeBytes.length - 1,
  );
  assert.equal(range.status, 206);
  assert.deepEqual(range.bytes, rangeBytes);
});

test("OSS 可变对象使用普通 PutObject 且不发送任何条件头", async () => {
  const calls: Array<{ key: string; headers: Record<string, string> }> = [];
  class FakeOssClient {
    async get(key: string) {
      return {
        content: Buffer.from("version: 1.1.10\n", "utf8"),
        res: { headers: { etag: '"etag-old"' } },
      };
    }

    async put(key: string, _bytes: Buffer, options: { headers: Record<string, string> }) {
      calls.push({ key, headers: { ...options.headers } });
      return { name: key };
    }
  }
  const remote = await createPlatformOssRemoteFromEnvironment(fakeEnvironment(), {
    loadOss: async () => ({ default: FakeOssClient }),
    fetch: async () => { throw new Error("本测试不得访问公开 HTTP"); },
  });
  await remote.putAtomic(
    stableMetadataKey,
    Buffer.from("version: 1.1.11\n", "utf8"),
    { contentType: "text/yaml", cacheControl: "no-cache" },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["If-Match"], undefined);
  assert.equal(calls[0].headers["If-None-Match"], undefined);
});

test("OSS 发布客户端必须为 Windows 大安装包配置十五分钟请求超时", async () => {
  let clientOptions: Record<string, unknown> | undefined;
  class FakeOssClient {
    constructor(options: Record<string, unknown>) {
      clientOptions = { ...options };
    }

    async put(key: string) {
      return { name: key };
    }
  }
  const remote = await createPlatformOssRemoteFromEnvironment(fakeEnvironment(), {
    loadOss: async () => ({ default: FakeOssClient }),
    fetch: async () => { throw new Error("本测试不得访问公开 HTTP"); },
  });

  await remote.putImmutable(
    "desktop/stable/windows/x64/fixture.exe",
    Buffer.from("fixture", "utf8"),
    { contentType: "application/octet-stream", cacheControl: "public,max-age=31536000,immutable" },
  );

  assert.equal(clientOptions?.timeout, 15 * 60 * 1000);
});

test("单写者证明缺失或错误时不读取也不写入远端", async () => {
  for (const [name, singleWriterProof] of [
    ["missing", undefined],
    ["mismatch", "github-actions:other/project:1:stable:windows-x64"],
  ] as const) {
    const fixture = createPublicationFixture(`single-writer-${name}`);
    const remote = new RecordingRemote({ stableVersion: "1.1.10", betaVersion: "1.1.10-beta.1" });
    try {
      await assert.rejects(() => publishStableWindowsTransaction({
        publicationRoot: fixture.root,
        version: VERSION,
        remote,
        singleWriterProof,
      }), /单写者证明/);
      assert.deepEqual(remote.keys, []);
      assert.deepEqual(remote.writes, []);
    } finally {
      removeTree(fixture.root);
    }
  }
});

test("不可变对象同 Key 异内容时拒绝推进任何平台指针", async () => {
  const fixture = createPublicationFixture("immutable-conflict");
  const remote = new RecordingRemote({ stableVersion: "1.1.10", betaVersion: "1.1.10-beta.1" });
  const firstImmutableKey = fixture.immutableKeys[0];
  remote.objects.set(firstImmutableKey, Buffer.from("conflicting-immutable-object", "utf8"));
  try {
    await assert.rejects(() => publishFixture(fixture, remote), /不可变对象.*冲突/);
    assert.equal(remote.writes.some((item) => item.includes("latest.json")), false);
  } finally {
    removeTree(fixture.root);
  }
});

test("Range 非 206 或公开摘要不一致时不推进平台 latest", async () => {
  for (const [name, mutate, expected] of [
    ["range", (remote: RecordingRemote) => { remote.rangeStatus = 200; }, /206|Content-Range/],
    ["digest", (remote: RecordingRemote, fixture: ReturnType<typeof createPublicationFixture>) => {
      remote.corruptPublicKey = fixture.immutableKeys[0];
    }, /200|SHA-256|摘要/],
  ] as const) {
    const fixture = createPublicationFixture(name);
    const remote = new RecordingRemote({ stableVersion: "1.1.10", betaVersion: "1.1.10-beta.1" });
    try {
      mutate(remote, fixture);
      await assert.rejects(() => publishFixture(fixture, remote), expected);
      assert.equal(remote.writes.some((item) => item.endsWith(stableLatestKey) || item.endsWith(betaLatestKey)), false);
    } finally {
      removeTree(fixture.root);
    }
  }
});

test("冻结的平台指针在事务期间改变时拒绝推进 latest", async () => {
  const fixture = createPublicationFixture("concurrent-pointer");
  const remote = new RecordingRemote({ stableVersion: "1.1.10", betaVersion: "1.1.10-beta.1" });
  remote.mutateOnSecondReadKey = stableLatestKey;
  try {
    await assert.rejects(() => publishFixture(fixture, remote), /事务期间发生变化|并发/);
    assert.equal(remote.writes.some((item) => item.endsWith(stableLatestKey) || item.endsWith(betaLatestKey)), false);
  } finally {
    removeTree(fixture.root);
  }
});

test("其他平台对象在任何远端写入前失败", async () => {
  const fixture = createPublicationFixture("foreign-object");
  const remote = new RecordingRemote({ stableVersion: "1.1.10", betaVersion: "1.1.10-beta.1" });
  const foreignPath = path.join(fixture.root, "desktop", "stable", "linux", "x64", "evil.AppImage");
  fs.mkdirSync(path.dirname(foreignPath), { recursive: true });
  fs.writeFileSync(foreignPath, "foreign", "utf8");
  try {
    await assert.rejects(() => publishFixture(fixture, remote), /Windows x64|其他平台|越界|未声明/);
    assert.deepEqual(remote.writes, []);
  } finally {
    removeTree(fixture.root);
  }
});

test("Stable 已推进而 Beta 指针中断后重跑保持幂等并补齐 Beta", async () => {
  const fixture = createPublicationFixture("resume");
  const remote = new RecordingRemote({ stableVersion: "1.1.10", betaVersion: "1.1.10-beta.1" });
  remote.failAtomicKey = betaLatestKey;
  remote.failAtomicCount = 1;
  try {
    await assert.rejects(() => publishFixture(fixture, remote), /指针写入中断/);
    assert.deepEqual(remote.objects.get(stableLatestKey), fixture.bytesByKey.get(stableLatestKey));
    assert.notDeepEqual(remote.objects.get(betaLatestKey), fixture.bytesByKey.get(betaLatestKey));
    const immutableWriteCount = remote.writes.filter((item) => item.startsWith("immutable:")).length;

    const result = await publishFixture(fixture, remote);
    assert.deepEqual(result.channels, ["stable", "beta"]);
    assert.deepEqual(remote.objects.get(betaLatestKey), fixture.bytesByKey.get(betaLatestKey));
    assert.equal(remote.writes.filter((item) => item.startsWith("immutable:")).length, immutableWriteCount);
    assert.deepEqual(remote.deleted, []);
  } finally {
    removeTree(fixture.root);
  }
});

test("手工补齐不可变对象后恢复发布不得再次 PUT，避免 OSS 提前拒绝触发 EPIPE", async () => {
  const fixture = createPublicationFixture("manual-upload-recovery");
  const remote = new RecordingRemote({ stableVersion: "1.1.10", betaVersion: "1.1.10-beta.1" });
  seedChannelImmutableObjects(remote, fixture, "stable");
  seedChannelImmutableObjects(remote, fixture, "beta");
  remote.throwEpipeOnExistingImmutablePut = true;
  try {
    const result = await publishFixture(fixture, remote);
    assert.deepEqual(result.channels, ["stable", "beta"]);
    assert.equal(remote.events.some((event) => event.startsWith("immutable-put:")), false);
    assert.deepEqual(remote.objects.get(stableLatestKey), fixture.bytesByKey.get(stableLatestKey));
    assert.deepEqual(remote.objects.get(betaLatestKey), fixture.bytesByKey.get(betaLatestKey));
  } finally {
    removeTree(fixture.root);
  }
});

function createPublicationFixture(name: string) {
  fs.mkdirSync(fixtureParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureParent, `${name}-`));
  const installerName = `天将漫创-${VERSION}-win-x64-setup.exe`;
  const blockmapName = `${installerName}.blockmap`;
  const sourceFiles = [
    { fileName: installerName, kind: "installer", bytes: Buffer.from("stable-installer\n", "utf8") },
    { fileName: blockmapName, kind: "blockmap", bytes: Buffer.from("stable-blockmap\n", "utf8") },
  ];
  const metadataBytes = Buffer.from(`version: ${VERSION}\npath: ${installerName}\n`, "utf8");
  const stableManifest = {
    schemaVersion: 2,
    version: VERSION,
    tag: `v${VERSION}`,
    channel: "stable",
    sourceChannel: "stable",
    platform: "windows",
    arch: "x64",
    commitSha: "a".repeat(40),
    repository: "hyc0122/tianjiang-manchuang",
    workflow: ".github/workflows/app-stable-release.yml",
    runId: "9001",
    runAttempt: "1",
    generatedAt: "2026-08-24T00:00:00.000Z",
    artifacts: [
      ...sourceFiles.map((file) => ({
        path: `desktop/stable/windows/x64/${file.fileName}`,
        fileName: file.fileName,
        platform: "windows",
        arch: "x64",
        kind: file.kind,
        size: file.bytes.length,
        sha256: sha256(file.bytes),
      })),
      {
        path: "desktop/stable/windows/x64/latest.yml",
        fileName: "latest.yml",
        platform: "windows",
        arch: "x64",
        kind: "metadata",
        size: metadataBytes.length,
        sha256: sha256(metadataBytes),
      },
    ].sort((left, right) => left.path.localeCompare(right.path, "en")),
  };
  const bytesByKey = new Map<string, Buffer>();
  const immutableKeys: string[] = [];

  for (const channel of ["stable", "beta"] as const) {
    const prefix = `desktop/${channel}/windows/x64`;
    const releaseRoot = `${prefix}/catalog/releases/${VERSION}`;
    const artifacts = sourceFiles.map((file) => {
      const key = `${prefix}/${file.fileName}`;
      bytesByKey.set(key, file.bytes);
      immutableKeys.push(key);
      return { path: key, fileName: file.fileName, kind: file.kind, size: file.bytes.length, sha256: sha256(file.bytes) };
    });
    bytesByKey.set(`${prefix}/latest.yml`, metadataBytes);
    const releaseBytes = jsonBytes({
      schemaVersion: 2,
      channel,
      sourceChannel: "stable",
      platform: "windows",
      arch: "x64",
      version: VERSION,
      tag: `v${VERSION}`,
      commitSha: "a".repeat(40),
      nativeMetadata: `${prefix}/latest.yml`,
      artifacts,
    });
    const channelManifest = {
      ...stableManifest,
      channel,
      artifacts: [
        ...artifacts.map((artifact) => ({
          path: artifact.path,
          fileName: artifact.fileName,
          platform: "windows",
          arch: "x64",
          kind: artifact.kind,
          size: artifact.size,
          sha256: artifact.sha256,
        })),
        {
          path: `${prefix}/latest.yml`,
          fileName: "latest.yml",
          platform: "windows",
          arch: "x64",
          kind: "metadata",
          size: metadataBytes.length,
          sha256: sha256(metadataBytes),
        },
      ].sort((left, right) => left.path.localeCompare(right.path, "en")),
    };
    const manifestBytes = jsonBytes(channelManifest);
    const sumsBytes = Buffer.from(
      `${channelManifest.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n")}\n`,
      "utf8",
    );
    const sigstoreBytes = sigstoreProofBytes(manifestBytes, `offline-${channel}-source-proof`);
    for (const [key, bytes] of [
      [`${releaseRoot}/release.json`, releaseBytes],
      [`${releaseRoot}/release-manifest.json`, manifestBytes],
      [`${releaseRoot}/SHA256SUMS`, sumsBytes],
      [`${releaseRoot}/release-manifest.json.sigstore.json`, sigstoreBytes],
    ] as const) {
      bytesByKey.set(key, bytes);
      immutableKeys.push(key);
    }
    bytesByKey.set(`${prefix}/catalog/latest.json`, latestBytes(channel, VERSION));
  }
  for (const [key, bytes] of bytesByKey) writeKey(root, key, bytes);
  return {
    root,
    bytesByKey,
    immutableKeys: immutableKeys.sort((left, right) => left.localeCompare(right, "en")),
    singleWriterProof: "github-actions:hyc0122/tianjiang-manchuang:9001:stable:windows-x64",
  };
}

function publishFixture(fixture: ReturnType<typeof createPublicationFixture>, remote: RecordingRemote) {
  return publishStableWindowsTransaction({
    publicationRoot: fixture.root,
    version: VERSION,
    remote,
    singleWriterProof: fixture.singleWriterProof,
  });
}

function seedChannelImmutableObjects(
  remote: RecordingRemote,
  fixture: ReturnType<typeof createPublicationFixture>,
  channel: "stable" | "beta",
) {
  const prefix = `desktop/${channel}/windows/x64/`;
  for (const key of fixture.immutableKeys.filter((candidate) => candidate.startsWith(prefix))) {
    remote.objects.set(key, Buffer.from(fixture.bytesByKey.get(key)!));
  }
}

function latestBytes(channel: "stable" | "beta", version: string) {
  return jsonBytes({
    schemaVersion: 2,
    channel,
    platform: "windows",
    arch: "x64",
    version,
    release: `desktop/${channel}/windows/x64/catalog/releases/${version}/release.json`,
  });
}

function fakeEnvironment() {
  return {
    OSS_ACCESS_KEY_ID: "fake-access-id",
    OSS_ACCESS_KEY_SECRET: "fake-access-secret",
    OSS_REGION: "oss-cn-qingdao",
    OSS_BUCKET: "offline-fixture-bucket",
    OSS_ENDPOINT: "https://oss-cn-qingdao.aliyuncs.com",
    TIANJIANG_RELEASE_PUBLIC_BASE_URL: "https://downloads.example.test/",
  };
}

function writeKey(root: string, key: string, bytes: Buffer) {
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

function sigstoreProofBytes(manifestBytes: Buffer, signature: string) {
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

function findLastIndex(values: string[], fragment: string) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index].includes(fragment)) return index;
  }
  return -1;
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

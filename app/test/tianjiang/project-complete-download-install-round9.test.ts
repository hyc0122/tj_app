/**
 * Round9 RED/GREEN：完整多对象下载与原子安装契约。
 * 任一对象失败不得破坏旧项目；全部成功后才原子切换。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import type { CentralAuthGateway, CentralSession } from "../../src/tianjiang/auth/central-session";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { ProjectStore } from "../../src/tianjiang/data/project-store";
import { CentralRuntimeAdapter } from "../../src/tianjiang/runtime/central-runtime-adapter";
import { RuntimeProjectLocal } from "../../src/tianjiang/runtime/project-runtime-local";
import { PersonalProjectSync } from "../../src/tianjiang/sync/personal-project-sync";

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-000000000092";
const deviceUuid = "018f3d6e-2d9e-7b6c-8a9b-1234567890a2";
const userSegment = "a".repeat(32);
const remoteVersion = 21;
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

const session = {
  id: "session",
  serverUrl: "https://api.example.invalid",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 7, username: "alice", nickname: "Alice" },
} as CentralSession;

const REMOTE_FILES: Array<{ relativePath: string; body: Buffer }> = [
  { relativePath: "files/images/character.png", body: Buffer.from("remote-png-bytes") },
  { relativePath: "files/videos/shot.mp4", body: Buffer.from("remote-mp4-bytes") },
  { relativePath: "files/audios/dialogue.mp3", body: Buffer.from("remote-mp3-bytes") },
  { relativePath: "files/thumbnails/character.webp", body: Buffer.from("remote-webp-bytes") },
  { relativePath: "files/references/style.jpg", body: Buffer.from("remote-jpg-bytes") },
  { relativePath: "files/imports/source.txt", body: Buffer.from("remote-import-text") },
  { relativePath: "files/attachments/notes.pdf", body: Buffer.from("%PDF-remote-notes") },
];

function md5Of(bytes: Buffer): string {
  return crypto.createHash("md5").update(bytes).digest("hex");
}

function buildRemoteDatabase(dataRoot: string): { bytes: Buffer; md5: string; size: number } {
  const remoteDatabasePath = path.join(dataRoot, "remote-project.sqlite");
  const remoteDatabase = new Database(remoteDatabasePath);
  remoteDatabase.exec(`
    CREATE TABLE o_novel (
      id INTEGER PRIMARY KEY,
      projectId INTEGER NOT NULL,
      chapter TEXT NOT NULL,
      chapterData TEXT NOT NULL
    );
    INSERT INTO o_novel(id, projectId, chapter, chapterData)
    VALUES (201, 1, '完整同步章', '含媒体引用的正文');
  `);
  remoteDatabase.close();
  const bytes = fs.readFileSync(remoteDatabasePath);
  return { bytes, md5: md5Of(bytes), size: bytes.length };
}

function remoteObjects(database: { bytes: Buffer; md5: string; size: number }) {
  return [
    { relativePath: "project.sqlite", size: database.size, md5: database.md5 },
    ...REMOTE_FILES.map((file) => ({
      relativePath: file.relativePath,
      size: file.body.length,
      md5: md5Of(file.body),
      mediaType: file.relativePath.includes("/images/") || file.relativePath.includes("/thumbnails/")
        || file.relativePath.endsWith(".jpg") || file.relativePath.endsWith(".webp")
        || file.relativePath.endsWith(".png")
        ? "image"
        : file.relativePath.includes("/videos/")
          ? "video"
          : file.relativePath.includes("/audios/")
            ? "audio"
            : file.relativePath.endsWith(".txt")
              ? "text"
              : "binary",
    })),
  ];
}

function seedLocalWithMedia(dataRoot: string, sentinelText: string): string {
  const localRoot = projectDirectory(dataRoot, projectUuid, userSegment);
  const store = new ProjectStore(dataRoot, projectUuid, "readwrite", userSegment);
  store.setRecord("sentinel", "local", { value: sentinelText });
  store.close();
  const oldImage = path.join(localRoot, "files", "images", "old-local.png");
  fs.mkdirSync(path.dirname(oldImage), { recursive: true });
  fs.writeFileSync(oldImage, Buffer.from("must-preserve-on-failed-install"));
  fs.writeFileSync(path.join(localRoot, ".tianjiang-manifest.json"), JSON.stringify({
    version: 1,
    objects: [{ relativePath: "project.sqlite", size: 1, md5: "1".repeat(32) }],
    installedDatabaseMD5: "1".repeat(32),
  }, null, 2));
  return localRoot;
}

test("中央版本含 7 类文件时下载端必须请求并校验全部对象", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-complete-download-all-"));
  const database = buildRemoteDatabase(dataRoot);
  const objects = remoteObjects(database);
  const bodyByPath = new Map<string, Buffer>([
    ["project.sqlite", database.bytes],
    ...REMOTE_FILES.map((f) => [f.relativePath, f.body] as const),
  ]);
  const authPaths: string[] = [];
  const downloadPaths: string[] = [];

  const gateway = {
    forwardBusinessRequest: async (
      _session: CentralSession,
      pathname: string,
      method: string,
      body?: unknown,
    ) => {
      if (pathname.endsWith(`/projects/${projectUuid}`)) {
        return { projectUuid, currentVersion: remoteVersion, objects };
      }
      if (pathname.endsWith("/object-authorizations")) {
        const request = body as { relativePath?: string; expiresInSeconds?: number };
        if ((request.expiresInSeconds ?? 0) > 600) {
          throw Object.assign(new Error("请求参数无效"), { status: 422 });
        }
        assert.equal(method, "POST");
        assert.ok(request.relativePath, "授权必须带 relativePath");
        authPaths.push(request.relativePath!);
        return {
          url: `https://oss.example.invalid/${encodeURIComponent(request.relativePath!)}?signature=redacted`,
        };
      }
      throw new Error(`未预期请求：${method} ${pathname}`);
    },
  } as unknown as CentralAuthGateway;

  const transport = async (input: string | URL | Request) => {
    const url = String(input);
    const match = /https:\/\/oss\.example\.invalid\/([^?]+)/.exec(url);
    assert.ok(match, `下载 URL 非法：${url}`);
    const relativePath = decodeURIComponent(match[1]);
    downloadPaths.push(relativePath);
    const payload = bodyByPath.get(relativePath);
    assert.ok(payload, `缺少远端对象：${relativePath}`);
    return new Response(Uint8Array.from(payload), {
      status: 200,
      headers: { "x-oss-request-id": "safe-download-request-id" },
    });
  };

  seedLocalWithMedia(dataRoot, "旧本地哨兵");
  const local = new RuntimeProjectLocal(dataRoot, projectUuid, userSegment);
  const adapter = new CentralRuntimeAdapter(
    gateway,
    session,
    deviceUuid,
    transport as typeof fetch,
  );
  const remote = adapter.personalRemote(projectUuid, (snapshot) => {
    local.acceptDownloaded(snapshot);
  }, {
    currentVersion: remoteVersion,
    readObject: () => Buffer.alloc(0),
  });
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();

  try {
    await sync.ensureLoaded();
    local.close();

    const expectedPaths = objects.map((item) => item.relativePath).sort();
    assert.deepEqual([...authPaths].sort(), expectedPaths, "必须为全部对象申请下载授权");
    assert.deepEqual([...downloadPaths].sort(), expectedPaths, "必须下载并校验全部对象");

    const installedRoot = projectDirectory(dataRoot, projectUuid, userSegment);
    for (const file of REMOTE_FILES) {
      const absolute = path.join(installedRoot, ...file.relativePath.split("/"));
      assert.ok(fs.existsSync(absolute), `安装后必须存在 ${file.relativePath}`);
      assert.deepEqual(fs.readFileSync(absolute), file.body);
    }
    const installed = new Database(path.join(installedRoot, "project.sqlite"), { readonly: true });
    try {
      const novel = installed.prepare(
        "SELECT chapter FROM o_novel WHERE id = ?",
      ).get(201) as { chapter: string };
      assert.equal(novel.chapter, "完整同步章");
    } finally {
      installed.close();
    }
  } finally {
    local.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("删除其中一个远端对象或篡改 MD5 时原子安装失败，旧项目目录/数据库/媒体保持不变", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-complete-download-fail-"));
  const database = buildRemoteDatabase(dataRoot);
  const objects = remoteObjects(database);
  // 中文注释：故意让视频对象 MD5 与实际内容不一致，验证 fail-closed。
  const tampered = objects.map((item) => (
    item.relativePath === "files/videos/shot.mp4"
      ? { ...item, md5: "f".repeat(32) }
      : item
  ));
  const bodyByPath = new Map<string, Buffer>([
    ["project.sqlite", database.bytes],
    ...REMOTE_FILES.map((f) => [f.relativePath, f.body] as const),
  ]);
  const authPaths: string[] = [];

  const gateway = {
    forwardBusinessRequest: async (
      _session: CentralSession,
      pathname: string,
      _method: string,
      body?: unknown,
    ) => {
      if (pathname.endsWith(`/projects/${projectUuid}`)) {
        return { projectUuid, currentVersion: remoteVersion, objects: tampered };
      }
      if (pathname.endsWith("/object-authorizations")) {
        const request = body as { relativePath?: string };
        authPaths.push(request.relativePath!);
        return {
          url: `https://oss.example.invalid/${encodeURIComponent(request.relativePath!)}?signature=redacted`,
        };
      }
      throw new Error(`未预期请求：${pathname}`);
    },
  } as unknown as CentralAuthGateway;

  const transport = async (input: string | URL | Request) => {
    const url = String(input);
    const match = /https:\/\/oss\.example\.invalid\/([^?]+)/.exec(url);
    const relativePath = decodeURIComponent(match![1]);
    return new Response(Uint8Array.from(bodyByPath.get(relativePath)!), { status: 200 });
  };

  const localRoot = seedLocalWithMedia(dataRoot, "安装失败必须保留");
  const oldDbBytes = fs.readFileSync(path.join(localRoot, "project.sqlite"));
  const oldImageBytes = fs.readFileSync(path.join(localRoot, "files", "images", "old-local.png"));
  const local = new RuntimeProjectLocal(dataRoot, projectUuid, userSegment);
  const adapter = new CentralRuntimeAdapter(
    gateway,
    session,
    deviceUuid,
    transport as typeof fetch,
  );
  const remote = adapter.personalRemote(projectUuid, (snapshot) => {
    local.acceptDownloaded(snapshot);
  }, {
    currentVersion: remoteVersion,
    readObject: () => Buffer.alloc(0),
  });
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();

  try {
    let loadError: unknown;
    try {
      await sync.ensureLoaded();
    } catch (error) {
      loadError = error;
    }

    // 完整下载契约：必须至少尝试全部对象；当前生产只拉 project.sqlite 时此处 RED。
    assert.ok(
      authPaths.includes("files/videos/shot.mp4"),
      `必须下载校验全部对象（含被篡改的视频）；实际授权路径=${authPaths.join(",")}`,
    );
    assert.ok(loadError, "篡改 MD5 的对象必须导致安装失败");
    assert.match(
      String((loadError as Error).message),
      /校验|不一致|下载|安装|MD5|checksum|对象/i,
    );

    assert.deepEqual(
      fs.readFileSync(path.join(localRoot, "project.sqlite")),
      oldDbBytes,
      "失败时旧数据库字节必须不变",
    );
    assert.deepEqual(
      fs.readFileSync(path.join(localRoot, "files", "images", "old-local.png")),
      oldImageBytes,
      "失败时旧媒体必须不变",
    );
    assert.equal(
      fs.existsSync(path.join(localRoot, "files", "videos", "shot.mp4")),
      false,
      "失败时不得留下半截新媒体",
    );
    const preserved = new ProjectStore(dataRoot, projectUuid, "readonly", userSegment);
    try {
      assert.deepEqual(preserved.getRecord("sentinel", "local"), { value: "安装失败必须保留" });
    } finally {
      preserved.close();
    }
  } finally {
    local.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("全部对象正确时一次原子切换后新数据库与全部媒体均可读", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-complete-download-ok-"));
  const database = buildRemoteDatabase(dataRoot);
  const objects = remoteObjects(database);
  const bodyByPath = new Map<string, Buffer>([
    ["project.sqlite", database.bytes],
    ...REMOTE_FILES.map((f) => [f.relativePath, f.body] as const),
  ]);

  const gateway = {
    forwardBusinessRequest: async (
      _session: CentralSession,
      pathname: string,
      _method: string,
      body?: unknown,
    ) => {
      if (pathname.endsWith(`/projects/${projectUuid}`)) {
        return { projectUuid, currentVersion: remoteVersion, objects };
      }
      if (pathname.endsWith("/object-authorizations")) {
        const request = body as { relativePath?: string };
        return {
          url: `https://oss.example.invalid/${encodeURIComponent(request.relativePath!)}?signature=redacted`,
        };
      }
      throw new Error(`未预期请求：${pathname}`);
    },
  } as unknown as CentralAuthGateway;

  const transport = async (input: string | URL | Request) => {
    const url = String(input);
    const match = /https:\/\/oss\.example\.invalid\/([^?]+)/.exec(url);
    const relativePath = decodeURIComponent(match![1]);
    return new Response(Uint8Array.from(bodyByPath.get(relativePath)!), { status: 200 });
  };

  seedLocalWithMedia(dataRoot, "将被完整版本替换");
  const local = new RuntimeProjectLocal(dataRoot, projectUuid, userSegment);
  const adapter = new CentralRuntimeAdapter(
    gateway,
    session,
    deviceUuid,
    transport as typeof fetch,
  );
  const remote = adapter.personalRemote(projectUuid, (snapshot) => {
    local.acceptDownloaded(snapshot);
  }, {
    currentVersion: remoteVersion,
    readObject: () => Buffer.alloc(0),
  });
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();

  try {
    await sync.ensureLoaded();
    local.close();

    const installedRoot = projectDirectory(dataRoot, projectUuid, userSegment);
    const installed = new Database(path.join(installedRoot, "project.sqlite"), { readonly: true });
    try {
      const novel = installed.prepare(
        "SELECT chapterData FROM o_novel WHERE id = ?",
      ).get(201) as { chapterData: string };
      assert.equal(novel.chapterData, "含媒体引用的正文");
    } finally {
      installed.close();
    }
    for (const file of REMOTE_FILES) {
      const absolute = path.join(installedRoot, ...file.relativePath.split("/"));
      assert.deepEqual(fs.readFileSync(absolute), file.body, file.relativePath);
    }
    const manifest = JSON.parse(
      fs.readFileSync(path.join(installedRoot, ".tianjiang-manifest.json"), "utf8"),
    ) as { objects: Array<{ relativePath: string }> };
    const manifestPaths = manifest.objects.map((item) => item.relativePath).sort();
    assert.deepEqual(
      manifestPaths,
      objects.map((item) => item.relativePath).sort(),
      "安装回执必须记录完整对象集合",
    );
  } finally {
    local.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

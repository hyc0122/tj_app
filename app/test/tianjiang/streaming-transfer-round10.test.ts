/**
 * Round10 RED：流式传输。
 * 禁止 Promise.all 全量 Buffer；下载写入 .incoming 并增量 MD5；安装消费暂存文件。
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

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-0000000000f1";
const deviceUuid = "018f3d6e-2d9e-7b6c-8a9b-1234567890f1";
const userSegment = "f1".repeat(16);
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

const session = {
  id: "session",
  serverUrl: "https://api.example.invalid",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 12, username: "stream", nickname: "Stream" },
} as CentralSession;

function md5Of(bytes: Buffer): string {
  return crypto.createHash("md5").update(bytes).digest("hex");
}

test("下载不得在内存中累积全部 objectContents；应流式落入 incoming 并原子安装", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-stream-dl-"));
  const remoteDbPath = path.join(dataRoot, "remote.sqlite");
  const db = new Database(remoteDbPath);
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t(v) VALUES ('stream');");
  db.close();
  const remoteDb = fs.readFileSync(remoteDbPath);
  const video = Buffer.alloc(512 * 1024, 9); // 512KB
  const objects = [
    { relativePath: "project.sqlite", size: remoteDb.length, md5: md5Of(remoteDb) },
    {
      relativePath: "files/videos/big.mp4",
      size: video.length,
      md5: md5Of(video),
      mediaType: "video",
    },
  ];
  const bodyByPath = new Map([
    ["project.sqlite", remoteDb],
    ["files/videos/big.mp4", video],
  ]);

  const localRoot = projectDirectory(dataRoot, projectUuid, userSegment);
  const empty = new ProjectStore(dataRoot, projectUuid, "readwrite", userSegment);
  empty.setRecord("sentinel", "x", { keep: true });
  empty.close();
  fs.writeFileSync(path.join(localRoot, ".tianjiang-manifest.json"), JSON.stringify({
    version: 1,
    objects: [{ relativePath: "project.sqlite", size: 1, md5: "1".repeat(32) }],
    installedDatabaseMD5: "1".repeat(32),
  }));

  const gateway = {
    forwardBusinessRequest: async (
      _s: CentralSession,
      pathname: string,
      _m: string,
      body?: unknown,
    ) => {
      if (pathname.endsWith(`/projects/${projectUuid}`)) {
        return { projectUuid, currentVersion: 9, objects };
      }
      if (pathname.endsWith("/object-authorizations")) {
        const rel = (body as { relativePath: string }).relativePath;
        return {
          url: `https://oss.example.invalid/dl/${encodeURIComponent(rel)}?sig=x`,
        };
      }
      throw new Error(`未预期 ${pathname}`);
    },
  } as unknown as CentralAuthGateway;

  const transport = async (input: string | URL | Request) => {
    const url = String(input);
    const match = /dl\/([^?]+)/.exec(url);
    const rel = decodeURIComponent(match![1]!);
    const payload = bodyByPath.get(rel)!;
    // 使用 ReadableStream 模拟流式 body
    return new Response(Uint8Array.from(payload), { status: 200 });
  };

  const local = new RuntimeProjectLocal(dataRoot, projectUuid, userSegment);
  const adapter = new CentralRuntimeAdapter(
    gateway,
    session,
    deviceUuid,
    transport as typeof fetch,
  );
  let acceptedObjectContentsKeys: string[] | undefined;
  const remote = adapter.personalRemote(projectUuid, (snapshot) => {
    acceptedObjectContentsKeys = Object.keys(snapshot.objectContents ?? {});
    local.acceptDownloaded(snapshot);
  }, {
    currentVersion: 9,
    readObject: () => Buffer.alloc(0),
  });
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();

  try {
    await sync.ensureLoaded();
    local.close();

    assert.ok(
      fs.existsSync(path.join(localRoot, "files", "videos", "big.mp4")),
      "安装后视频必须存在",
    );
    assert.deepEqual(
      fs.readFileSync(path.join(localRoot, "files", "videos", "big.mp4")),
      video,
    );

    // 契约：大文件不得以全量 objectContents 为权威载体；应使用 staging 目录路径。
    // RED：当前实现会把全部对象装入 objectContents（含 512KB 视频）。
    assert.ok(
      acceptedObjectContentsKeys
        && !acceptedObjectContentsKeys.includes("files/videos/big.mp4"),
      `大视频不得进入 objectContents 内存表（当前 keys=${acceptedObjectContentsKeys?.join(",") ?? "none"}）`,
    );
    assert.ok(
      typeof (local as { consumeIncomingInstall?: unknown }).consumeIncomingInstall === "function"
        || typeof (adapter as { lastDownloadStagingDir?: string }).lastDownloadStagingDir === "string",
      "必须提供 incoming 暂存安装路径接口",
    );
  } finally {
    local.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("needsInstall 必须对现有媒体校验真实 size/MD5，仅 path 存在不够", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-needs-install-"));
  const store = new ProjectStore(dataRoot, projectUuid, "readwrite", userSegment);
  store.setRecord("runtime", "seed", { ok: true });
  store.close();
  const root = projectDirectory(dataRoot, projectUuid, userSegment);
  const mediaPath = path.join(root, "files", "images", "a.png");
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
  const good = Buffer.from("good-bytes");
  fs.writeFileSync(mediaPath, good);
  const goodMd5 = md5Of(good);
  fs.writeFileSync(path.join(root, ".tianjiang-manifest.json"), JSON.stringify({
    version: 3,
    objects: [
      { relativePath: "project.sqlite", size: 1, md5: "a".repeat(32) },
      { relativePath: "files/images/a.png", size: good.length, md5: goodMd5 },
    ],
    installedDatabaseMD5: "a".repeat(32),
  }));
  const local = new RuntimeProjectLocal(dataRoot, projectUuid, userSegment);
  try {
    // 篡改磁盘字节但保留路径
    fs.writeFileSync(mediaPath, Buffer.from("tampered!!"));
    const needs = local.needsInstall({
      version: 3,
      objects: [
        { relativePath: "project.sqlite", size: 1, md5: "a".repeat(32) },
        { relativePath: "files/images/a.png", size: good.length, md5: goodMd5 },
      ],
    });
    assert.equal(needs, true, "媒体 size/MD5 不一致时 needsInstall 必须为 true");
  } finally {
    local.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

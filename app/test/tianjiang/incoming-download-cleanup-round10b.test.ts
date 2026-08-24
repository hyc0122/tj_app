/**
 * Round10b RED：incoming 下载目录所有权与清理。
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

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-0000000001e1";
const deviceUuid = "018f3d6e-2d9e-7b6c-8a9b-1234567890e1";
const userSegment = "e1".repeat(16);
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

const session = {
  id: "session",
  serverUrl: "https://api.example.invalid",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 91, username: "incoming", nickname: "In" },
} as CentralSession;

function md5Of(bytes: Buffer): string {
  return crypto.createHash("md5").update(bytes).digest("hex");
}

test("成功安装后 operation incoming 目录必须删除；路径不得依赖 process.cwd 权威位置", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-r10b-inc-ok-"));
  const remoteDbPath = path.join(dataRoot, "remote.sqlite");
  const db = new Database(remoteDbPath);
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY); INSERT INTO t DEFAULT VALUES;");
  db.close();
  const remoteDb = fs.readFileSync(remoteDbPath);
  const video = Buffer.alloc(64 * 1024, 5);
  const objects = [
    { relativePath: "project.sqlite", size: remoteDb.length, md5: md5Of(remoteDb) },
    {
      relativePath: "files/videos/x.mp4",
      size: video.length,
      md5: md5Of(video),
      mediaType: "video" as const,
    },
  ];
  const bodyByPath = new Map([
    ["project.sqlite", remoteDb],
    ["files/videos/x.mp4", video],
  ]);

  const localRoot = projectDirectory(dataRoot, projectUuid, userSegment);
  const empty = new ProjectStore(dataRoot, projectUuid, "readwrite", userSegment);
  empty.setRecord("s", "x", { k: 1 });
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
        return { projectUuid, currentVersion: 8, objects };
      }
      if (pathname.endsWith("/object-authorizations")) {
        const rel = (body as { relativePath: string }).relativePath;
        return { url: `https://oss.example.invalid/dl/${encodeURIComponent(rel)}?sig=x` };
      }
      throw new Error(`未预期 ${pathname}`);
    },
  } as unknown as CentralAuthGateway;

  const transport = async (input: string | URL | Request) => {
    const url = String(input);
    const match = /dl\/([^?]+)/.exec(url);
    const rel = decodeURIComponent(match![1]!);
    return new Response(Uint8Array.from(bodyByPath.get(rel)!), { status: 200 });
  };

  const local = new RuntimeProjectLocal(dataRoot, projectUuid, userSegment);
  const adapter = new CentralRuntimeAdapter(gateway, session, deviceUuid, transport as typeof fetch);
  adapter.bindIncomingStorage(dataRoot, userSegment);
  let snapshotIncoming: string | undefined;
  const remote = adapter.personalRemote(projectUuid, (snapshot) => {
    snapshotIncoming = (snapshot as { incomingRoot?: string; stagingRoot?: string }).incomingRoot
      ?? (snapshot as { stagingRoot?: string }).stagingRoot;
    local.acceptDownloaded(snapshot);
  }, {
    currentVersion: 8,
    readObject: () => Buffer.alloc(0),
  });
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();

  try {
    await sync.ensureLoaded();
    assert.ok(
      typeof snapshotIncoming === "string" && snapshotIncoming.length > 0,
      "DownloadedProjectSnapshot 必须带 incomingRoot/stagingRoot",
    );
    assert.ok(
      snapshotIncoming.includes(dataRoot) || snapshotIncoming.includes("runtime-users"),
      `incoming 必须位于账号数据根，不得用 process.cwd 权威路径：${snapshotIncoming}`,
    );
    assert.equal(
      fs.existsSync(snapshotIncoming),
      false,
      "成功安装后 operation 目录必须删除",
    );
    assert.ok(fs.existsSync(path.join(localRoot, "files", "videos", "x.mp4")));
  } finally {
    local.close();
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* lock */ }
  }
});

test("checksum 失败后 incoming operation 目录必须删除", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-r10b-inc-bad-"));
  const remoteDb = Buffer.from("db-bytes");
  const objects = [
    { relativePath: "project.sqlite", size: remoteDb.length, md5: md5Of(remoteDb) },
    {
      relativePath: "files/images/a.png",
      size: 4,
      md5: "c".repeat(32), // 故意与真实内容不一致
      mediaType: "image" as const,
    },
  ];
  const gateway = {
    forwardBusinessRequest: async (
      _s: CentralSession,
      pathname: string,
      _m: string,
      body?: unknown,
    ) => {
      if (pathname.endsWith(`/projects/${projectUuid}`)) {
        return { projectUuid, currentVersion: 3, objects };
      }
      if (pathname.endsWith("/object-authorizations")) {
        const rel = (body as { relativePath: string }).relativePath;
        return { url: `https://oss.example.invalid/dl/${encodeURIComponent(rel)}?sig=x` };
      }
      throw new Error(`未预期 ${pathname}`);
    },
  } as unknown as CentralAuthGateway;
  const transport = async (input: string | URL | Request) => {
    const url = String(input);
    const rel = decodeURIComponent(/dl\/([^?]+)/.exec(url)![1]!);
    const payload = rel === "project.sqlite" ? remoteDb : Buffer.from("xxxx");
    return new Response(Uint8Array.from(payload), { status: 200 });
  };
  const empty = new ProjectStore(dataRoot, projectUuid, "readwrite", userSegment);
  empty.setRecord("s", "x", {});
  empty.close();
  const adapter = new CentralRuntimeAdapter(gateway, session, deviceUuid, transport as typeof fetch);
  adapter.bindIncomingStorage(dataRoot, userSegment);
  let lastDir: string | undefined;
  const local = new RuntimeProjectLocal(dataRoot, projectUuid, userSegment);
  const remote = adapter.personalRemote(projectUuid, (s) => {
    lastDir = (s as { incomingRoot?: string }).incomingRoot
      ?? (adapter as { lastDownloadStagingDir?: string }).lastDownloadStagingDir;
    local.acceptDownloaded(s);
  }, { currentVersion: 3, readObject: () => Buffer.alloc(0) });
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();
  try {
    await assert.rejects(() => sync.ensureLoaded(), /不一致|checksum|MD5|摘要/i);
    const dir = lastDir ?? (adapter as { lastDownloadStagingDir?: string }).lastDownloadStagingDir;
    assert.ok(dir, "必须暴露 operation 目录路径");
    assert.equal(fs.existsSync(dir!), false, "checksum 失败后目录必须删除");
  } finally {
    local.close();
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* lock */ }
  }
});

test("启动清理只删过期 orphan，不删活跃/越界目录", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-r10b-inc-sweep-"));
  const { sweepExpiredIncomingDownloads } = await import(
    "../../src/tianjiang/runtime/central-runtime-adapter"
  );
  assert.equal(typeof sweepExpiredIncomingDownloads, "function", "必须提供 orphan incoming 清理入口");

  const incomingRoot = path.join(dataRoot, "runtime-users", userSegment, "incoming-downloads");
  const expired = path.join(incomingRoot, projectUuid, "old-op");
  const active = path.join(incomingRoot, projectUuid, "active-op");
  const escape = path.join(dataRoot, "escape-outside");
  fs.mkdirSync(expired, { recursive: true });
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(escape, { recursive: true });
  fs.writeFileSync(path.join(expired, "x"), "e");
  fs.writeFileSync(path.join(active, "x"), "a");
  // 过期 mtime
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  fs.utimesSync(expired, old, old);

  try {
    const n = sweepExpiredIncomingDownloads(dataRoot, { maxAgeMs: 24 * 3600 * 1000 });
    assert.ok(n >= 1, "应清理过期 orphan");
    assert.equal(fs.existsSync(expired), false);
    assert.equal(fs.existsSync(active), true, "活跃目录不得删");
    assert.equal(fs.existsSync(escape), true, "越界目录不得删");
  } finally {
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* lock */ }
  }
});

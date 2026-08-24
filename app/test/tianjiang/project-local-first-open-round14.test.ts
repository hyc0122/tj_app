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
import { createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-0000000000d1";
const deviceUuid = "018f3d6e-2d9e-7b6c-8a9b-1234567890d1";
const userSegment = "b".repeat(32);
const session = {
  id: "session-local-first",
  serverUrl: "https://api.example.invalid",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 7, username: "alice", nickname: "Alice" },
} as CentralSession;

function md5Of(bytes: Buffer): string {
  return crypto.createHash("md5").update(bytes).digest("hex");
}

function writeSqlite(target: string, chapter: string): Buffer {
  const database = new Database(target);
  database.exec(`
    CREATE TABLE IF NOT EXISTS o_novel (
      id INTEGER PRIMARY KEY,
      chapter TEXT NOT NULL
    );
    DELETE FROM o_novel;
    INSERT INTO o_novel(id, chapter) VALUES (1, '${chapter}');
  `);
  database.close();
  return fs.readFileSync(target);
}

async function openWithCounts(options: {
  dataRoot: string;
  remoteVersion: number;
  objects: Array<{ relativePath: string; size: number; md5: string }>;
  bodies: Map<string, Buffer>;
}) {
  const counts = { manifest: 0, authorize: 0, get: 0 };
  const gateway = {
    forwardBusinessRequest: async (
      _session: CentralSession,
      pathname: string,
      _method: string,
      body?: unknown,
    ) => {
      if (pathname.endsWith(`/projects/${projectUuid}`)) {
        counts.manifest += 1;
        return { projectUuid, currentVersion: options.remoteVersion, objects: options.objects };
      }
      if (pathname.endsWith("/object-authorizations")) {
        counts.authorize += 1;
        const relativePath = String((body as { relativePath?: string }).relativePath);
        return { url: `https://oss.example.invalid/${encodeURIComponent(relativePath)}?s=1` };
      }
      throw new Error(`未预期 ${pathname}`);
    },
  } as unknown as CentralAuthGateway;
  const transport = async (input: string | URL | Request) => {
    counts.get += 1;
    const relativePath = decodeURIComponent(/oss\.example\.invalid\/([^?]+)/.exec(String(input))?.[1] ?? "");
    return new Response(Uint8Array.from(options.bodies.get(relativePath) ?? Buffer.alloc(0)), { status: 200 });
  };
  const local = new RuntimeProjectLocal(options.dataRoot, projectUuid, userSegment);
  const adapter = new CentralRuntimeAdapter(gateway, session, deviceUuid, transport as typeof fetch);
  adapter.bindIncomingStorage(options.dataRoot, userSegment);
  const remote = adapter.personalRemote(projectUuid, (snapshot) => local.acceptDownloaded(snapshot), {
    currentVersion: options.remoteVersion,
    readObject: () => Buffer.alloc(0),
  });
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();
  try {
    await sync.ensureLoaded();
  } catch (error) {
    if (!(error instanceof Error) || !/安装|SQLITE|CANTOPEN/.test(error.message + String((error as { cause?: unknown }).cause))) {
      throw error;
    }
  }
  local.close();
  return counts;
}

test("本地完整且 hash 一致时 manifest=1、对象授权=0、GET=0", async () => {
  const dataRoot = createUniqueWorktreeRoot("local-first-complete");
  const root = projectDirectory(dataRoot, projectUuid, userSegment);
  fs.mkdirSync(path.join(root, "files", "videos"), { recursive: true });
  const sqlite = writeSqlite(path.join(root, "project.sqlite"), "本地章");
  const video = Buffer.from("local-video-bytes-should-not-redownload");
  fs.writeFileSync(path.join(root, "files", "videos", "shot.mp4"), video);
  const objects = [
    { relativePath: "project.sqlite", size: sqlite.length, md5: md5Of(sqlite) },
    { relativePath: "files/videos/shot.mp4", size: video.length, md5: md5Of(video) },
  ];
  fs.writeFileSync(path.join(root, ".tianjiang-manifest.json"), JSON.stringify({
    version: 8,
    objects,
    installedDatabaseMD5: md5Of(sqlite),
  }));
  new ProjectStore(dataRoot, projectUuid, "readwrite", userSegment).close();

  const counts = await openWithCounts({
    dataRoot,
    remoteVersion: 8,
    objects,
    bodies: new Map([["project.sqlite", sqlite], ["files/videos/shot.mp4", video]]),
  });
  assert.equal(counts.manifest, 1);
  assert.equal(counts.authorize, 0, "本地一致时对象授权必须为 0");
  assert.equal(counts.get, 0, "本地一致时对象 GET 必须为 0");
});

test("只变更 sqlite 时大视频不得再次 GET", async () => {
  const dataRoot = createUniqueWorktreeRoot("local-first-sqlite-only");
  const root = projectDirectory(dataRoot, projectUuid, userSegment);
  fs.mkdirSync(path.join(root, "files", "videos"), { recursive: true });
  const oldSqlite = writeSqlite(path.join(root, "project.sqlite"), "旧章");
  const video = Buffer.alloc(256 * 1024, 7);
  fs.writeFileSync(path.join(root, "files", "videos", "shot.mp4"), video);
  const newSqlitePath = path.join(dataRoot, "remote.sqlite");
  const newSqlite = writeSqlite(newSqlitePath, "xin");
  fs.writeFileSync(path.join(root, ".tianjiang-manifest.json"), JSON.stringify({
    version: 8,
    objects: [
      { relativePath: "project.sqlite", size: oldSqlite.length, md5: md5Of(oldSqlite) },
      { relativePath: "files/videos/shot.mp4", size: video.length, md5: md5Of(video) },
    ],
    installedDatabaseMD5: md5Of(oldSqlite),
  }));
  new ProjectStore(dataRoot, projectUuid, "readwrite", userSegment).close();

  const counts = await openWithCounts({
    dataRoot,
    remoteVersion: 9,
    objects: [
      { relativePath: "project.sqlite", size: newSqlite.length, md5: md5Of(newSqlite) },
      { relativePath: "files/videos/shot.mp4", size: video.length, md5: md5Of(video) },
    ],
    bodies: new Map([["project.sqlite", newSqlite], ["files/videos/shot.mp4", video]]),
  });
  assert.equal(counts.manifest, 1);
  assert.equal(counts.authorize, 1);
  assert.equal(counts.get, 1, "未变化的大视频不得再次 GET");
});

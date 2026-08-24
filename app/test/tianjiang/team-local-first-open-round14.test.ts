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
import { TeamProjectSync } from "../../src/tianjiang/sync/team-project-sync";
import { createUniqueWorktreeRoot } from "./helpers/worktree-runtime";

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-0000000000e1";
const deviceUuid = "018f3d6e-2d9e-7b6c-8a9b-1234567890e1";
const userSegment = "c".repeat(32);
const session = {
  id: "session-team-local-first",
  serverUrl: "https://api.example.invalid",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 8, username: "viewer", nickname: "Viewer" },
} as CentralSession;

function md5Of(bytes: Buffer): string {
  return crypto.createHash("md5").update(bytes).digest("hex");
}

test("Team viewer 本地一致时零授权零 GET，且不得写入", async () => {
  const dataRoot = createUniqueWorktreeRoot("team-local-first");
  const root = projectDirectory(dataRoot, projectUuid, userSegment);
  fs.mkdirSync(path.join(root, "files", "images"), { recursive: true });
  const sqlitePath = path.join(root, "project.sqlite");
  const db = new Database(sqlitePath);
  db.exec("CREATE TABLE o_meta(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO o_meta(v) VALUES ('team');");
  db.close();
  const sqlite = fs.readFileSync(sqlitePath);
  const image = Buffer.from("team-local-image");
  fs.writeFileSync(path.join(root, "files", "images", "a.png"), image);
  const objects = [
    { relativePath: "project.sqlite", size: sqlite.length, md5: md5Of(sqlite) },
    { relativePath: "files/images/a.png", size: image.length, md5: md5Of(image) },
  ];
  fs.writeFileSync(path.join(root, ".tianjiang-manifest.json"), JSON.stringify({
    version: 4,
    objects,
    installedDatabaseMD5: md5Of(sqlite),
  }));
  new ProjectStore(dataRoot, projectUuid, "readonly", userSegment).close();

  const counts = { manifest: 0, authorize: 0, get: 0, acquire: 0 };
  const gateway = {
    forwardBusinessRequest: async (
      _session: CentralSession,
      pathname: string,
      method: string,
      body?: unknown,
    ) => {
      if (pathname.endsWith(`/projects/${projectUuid}`) && method === "GET") {
        counts.manifest += 1;
        return { projectUuid, currentVersion: 4, objects };
      }
      if (pathname.endsWith("/object-authorizations")) {
        counts.authorize += 1;
        const relativePath = String((body as { relativePath?: string } | undefined)?.relativePath ?? "x");
        return { url: `https://oss.example.invalid/${encodeURIComponent(relativePath)}?s=1` };
      }
      if (pathname.endsWith("/lock") && method === "POST") {
        counts.acquire += 1;
        return { lockId: "lock", fencingToken: 1 };
      }
      throw new Error(`未预期 ${method} ${pathname}`);
    },
  } as unknown as CentralAuthGateway;

  const local = new RuntimeProjectLocal(dataRoot, projectUuid, userSegment);
  const bodies = new Map([["project.sqlite", sqlite], ["files/images/a.png", image]]);
  const adapter = new CentralRuntimeAdapter(gateway, session, deviceUuid, (async (input) => {
    counts.get += 1;
    const relativePath = decodeURIComponent(/oss\.example\.invalid\/([^?]+)/.exec(String(input))?.[1] ?? "");
    return new Response(Uint8Array.from(bodies.get(relativePath) ?? Buffer.alloc(0)), { status: 200 });
  }) as typeof fetch);
  adapter.bindIncomingStorage(dataRoot, userSegment);
  const remote = adapter.teamRemote(projectUuid, (snapshot) => local.acceptDownloaded(snapshot), {
    currentVersion: 4,
    readObject: () => Buffer.alloc(0),
    resolveObjectPath: (relativePath) => path.join(root, ...relativePath.split("/")),
    resolveInventoryPath: (relativePath) => local.resolveLocalInventoryPath(relativePath),
  });
  const sync = new TeamProjectSync("viewer", local, remote, () => ({}));
  try {
    await sync.open();
  } catch (error) {
    if (!(error instanceof Error) || !/安装|SQLITE|CANTOPEN/.test(error.message)) throw error;
  }

  assert.equal(counts.manifest, 1);
  assert.equal(counts.authorize, 0, "Team 本地一致时对象授权必须为 0");
  assert.equal(counts.get, 0, "Team 本地一致时对象 GET 必须为 0");
  assert.equal(counts.acquire, 0, "viewer 不得获取写锁");
  assert.throws(
    () => local.setRecord("runtime", "write", { n: 1 }),
    /只读/,
  );
  local.close();
});

function writeTeamSqlite(target: string, chapter: string): Buffer {
  const database = new Database(target);
  database.exec(`
    CREATE TABLE IF NOT EXISTS o_meta (id INTEGER PRIMARY KEY, v TEXT NOT NULL);
    DELETE FROM o_meta;
    INSERT INTO o_meta(id, v) VALUES (1, '${chapter}');
  `);
  database.close();
  return fs.readFileSync(target);
}

async function openTeamViewerWithCounts(options: {
  dataRoot: string;
  remoteVersion: number;
  objects: Array<{ relativePath: string; size: number; md5: string }>;
  bodies: Map<string, Buffer>;
  wireInventory: boolean;
}): Promise<{
  counts: { manifest: number; authorize: number; get: number; acquire: number };
  error: Error | undefined;
}> {
  const counts = { manifest: 0, authorize: 0, get: 0, acquire: 0 };
  const gateway = {
    forwardBusinessRequest: async (
      _session: CentralSession,
      pathname: string,
      method: string,
      body?: unknown,
    ) => {
      if (pathname.endsWith(`/projects/${projectUuid}`) && method === "GET") {
        counts.manifest += 1;
        return { projectUuid, currentVersion: options.remoteVersion, objects: options.objects };
      }
      if (pathname.endsWith("/object-authorizations")) {
        counts.authorize += 1;
        const relativePath = String((body as { relativePath?: string } | undefined)?.relativePath ?? "x");
        return { url: `https://oss.example.invalid/${encodeURIComponent(relativePath)}?s=1` };
      }
      if (pathname.endsWith("/lock") && method === "POST") {
        counts.acquire += 1;
        return { lockId: "lock", fencingToken: 1 };
      }
      throw new Error(`未预期 ${method} ${pathname}`);
    },
  } as unknown as CentralAuthGateway;
  const local = new RuntimeProjectLocal(options.dataRoot, projectUuid, userSegment);
  const adapter = new CentralRuntimeAdapter(gateway, session, deviceUuid, (async (input) => {
    counts.get += 1;
    const relativePath = decodeURIComponent(/oss\.example\.invalid\/([^?]+)/.exec(String(input))?.[1] ?? "");
    return new Response(Uint8Array.from(options.bodies.get(relativePath) ?? Buffer.alloc(0)), { status: 200 });
  }) as typeof fetch);
  adapter.bindIncomingStorage(options.dataRoot, userSegment);
  const remote = adapter.teamRemote(projectUuid, (snapshot) => local.acceptDownloaded(snapshot), {
    currentVersion: options.remoteVersion,
    readObject: () => Buffer.alloc(0),
    resolveObjectPath: (relativePath) => path.join(
      projectDirectory(options.dataRoot, projectUuid, userSegment),
      ...relativePath.split("/"),
    ),
    ...(options.wireInventory
      ? { resolveInventoryPath: (relativePath: string) => local.resolveLocalInventoryPath(relativePath) }
      : {}),
  });
  const sync = new TeamProjectSync("viewer", local, remote, () => ({}));
  let error: Error | undefined;
  try {
    await sync.open();
  } catch (caught) {
    if (caught instanceof Error) error = caught;
    else throw caught;
  }
  local.close();
  return { counts, error };
}

test("Team 仅 sqlite 变化时仍只拉一次 manifest，未变图片不得 GET", async () => {
  const dataRoot = createUniqueWorktreeRoot("team-sqlite-only");
  const root = projectDirectory(dataRoot, projectUuid, userSegment);
  fs.mkdirSync(path.join(root, "files", "images"), { recursive: true });
  const oldSqlite = writeTeamSqlite(path.join(root, "project.sqlite"), "old");
  const image = Buffer.from("team-stable-image");
  fs.writeFileSync(path.join(root, "files", "images", "a.png"), image);
  const newSqlite = writeTeamSqlite(path.join(dataRoot, "remote.sqlite"), "xin");
  fs.writeFileSync(path.join(root, ".tianjiang-manifest.json"), JSON.stringify({
    version: 4,
    objects: [
      { relativePath: "project.sqlite", size: oldSqlite.length, md5: md5Of(oldSqlite) },
      { relativePath: "files/images/a.png", size: image.length, md5: md5Of(image) },
    ],
    installedDatabaseMD5: md5Of(oldSqlite),
  }));
  new ProjectStore(dataRoot, projectUuid, "readonly", userSegment).close();

  const { counts, error } = await openTeamViewerWithCounts({
    dataRoot,
    remoteVersion: 5,
    objects: [
      { relativePath: "project.sqlite", size: newSqlite.length, md5: md5Of(newSqlite) },
      { relativePath: "files/images/a.png", size: image.length, md5: md5Of(image) },
    ],
    bodies: new Map([["project.sqlite", newSqlite], ["files/images/a.png", image]]),
    wireInventory: true,
  });
  if (error && !/安装|SQLITE|CANTOPEN/.test(error.message)) throw error;
  assert.equal(counts.manifest, 1, `变化对象下载不得再次 GET 项目清单，实际=${counts.manifest}`);
  assert.equal(counts.authorize, 1, "只允许变化 sqlite 申请一次对象授权");
  assert.equal(counts.get, 1, "未变化图片不得再次 GET");
  assert.equal(counts.acquire, 0, "viewer 不得获取写锁");
});

test("Team 下载缺少盘点入口时必须失败关闭且零授权零 GET", async () => {
  const dataRoot = createUniqueWorktreeRoot("team-missing-inventory");
  const root = projectDirectory(dataRoot, projectUuid, userSegment);
  fs.mkdirSync(path.join(root, "files", "images"), { recursive: true });
  const sqlite = writeTeamSqlite(path.join(root, "project.sqlite"), "team");
  const image = Buffer.from("team-local-image");
  fs.writeFileSync(path.join(root, "files", "images", "a.png"), image);
  const objects = [
    { relativePath: "project.sqlite", size: sqlite.length, md5: md5Of(sqlite) },
    { relativePath: "files/images/a.png", size: image.length, md5: md5Of(image) },
  ];
  fs.writeFileSync(path.join(root, ".tianjiang-manifest.json"), JSON.stringify({
    version: 4,
    objects,
    installedDatabaseMD5: md5Of(sqlite),
  }));
  new ProjectStore(dataRoot, projectUuid, "readonly", userSegment).close();

  const { counts, error } = await openTeamViewerWithCounts({
    dataRoot,
    remoteVersion: 4,
    objects,
    bodies: new Map([["project.sqlite", sqlite], ["files/images/a.png", image]]),
    wireInventory: false,
  });
  assert.ok(error, "缺少盘点入口必须失败关闭，不得假装本地下载成功");
  assert.equal(
    (error as Error & { code?: string }).code,
    "PROJECT_DOWNLOAD_INVENTORY_RESOLVER_MISSING",
  );
  assert.equal(counts.authorize, 0, "缺少盘点入口时对象授权必须为 0");
  assert.equal(counts.get, 0, "缺少盘点入口时对象 GET 必须为 0");
  assert.equal(counts.acquire, 0, "viewer 不得获取写锁");
});

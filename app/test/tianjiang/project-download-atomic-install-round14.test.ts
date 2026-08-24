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

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-0000000000f1";
const deviceUuid = "018f3d6e-2d9e-7b6c-8a9b-1234567890f1";
const userSegment = "d".repeat(32);
const session = {
  id: "session-atomic",
  serverUrl: "https://api.example.invalid",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 7, username: "alice", nickname: "Alice" },
} as CentralSession;

function md5Of(bytes: Buffer): string {
  return crypto.createHash("md5").update(bytes).digest("hex");
}

test("单对象 checksum 失败时旧数据库和旧媒体保持不变", async () => {
  const dataRoot = createUniqueWorktreeRoot("atomic-checksum");
  const root = projectDirectory(dataRoot, projectUuid, userSegment);
  fs.mkdirSync(path.join(root, "files", "images"), { recursive: true });
  const sqlitePath = path.join(root, "project.sqlite");
  const db = new Database(sqlitePath);
  db.exec("CREATE TABLE o_meta(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO o_meta(v) VALUES ('old');");
  db.close();
  const oldSqlite = fs.readFileSync(sqlitePath);
  const oldImage = Buffer.from("old-image-keep");
  fs.writeFileSync(path.join(root, "files", "images", "keep.png"), oldImage);
  fs.writeFileSync(path.join(root, ".tianjiang-manifest.json"), JSON.stringify({
    version: 2,
    objects: [
      { relativePath: "project.sqlite", size: oldSqlite.length, md5: md5Of(oldSqlite) },
      { relativePath: "files/images/keep.png", size: oldImage.length, md5: md5Of(oldImage) },
    ],
    installedDatabaseMD5: md5Of(oldSqlite),
  }));
  new ProjectStore(dataRoot, projectUuid, "readwrite", userSegment).close();

  const newSqlite = Buffer.concat([oldSqlite, Buffer.from("x")]);
  const gateway = {
    forwardBusinessRequest: async (
      _session: CentralSession,
      pathname: string,
      _method: string,
      body?: unknown,
    ) => {
      if (pathname.endsWith(`/projects/${projectUuid}`)) {
        return {
          projectUuid,
          currentVersion: 3,
          objects: [
            { relativePath: "project.sqlite", size: newSqlite.length, md5: md5Of(newSqlite) },
            { relativePath: "files/images/keep.png", size: oldImage.length, md5: "f".repeat(32) },
          ],
        };
      }
      if (pathname.endsWith("/object-authorizations")) {
        const relativePath = String((body as { relativePath?: string }).relativePath);
        return { url: `https://oss.example.invalid/${encodeURIComponent(relativePath)}?s=1` };
      }
      throw new Error(`未预期 ${pathname}`);
    },
  } as unknown as CentralAuthGateway;

  const local = new RuntimeProjectLocal(dataRoot, projectUuid, userSegment);
  const adapter = new CentralRuntimeAdapter(gateway, session, deviceUuid, (async (input) => {
    const relativePath = decodeURIComponent(/oss\.example\.invalid\/([^?]+)/.exec(String(input))?.[1] ?? "");
    const payload = relativePath === "project.sqlite" ? newSqlite : oldImage;
    return new Response(Uint8Array.from(payload), { status: 200 });
  }) as typeof fetch);
  adapter.bindIncomingStorage(dataRoot, userSegment);
  const remote = adapter.personalRemote(projectUuid, (snapshot) => local.acceptDownloaded(snapshot), {
    currentVersion: 3,
    readObject: () => Buffer.alloc(0),
  });
  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();
  await assert.rejects(() => sync.ensureLoaded(), /不一致|checksum|摘要/i);

  assert.deepEqual(fs.readFileSync(path.join(root, "files", "images", "keep.png")), oldImage);
  const live = new Database(sqlitePath, { readonly: true });
  try {
    const row = live.prepare("SELECT v FROM o_meta").get() as { v: string };
    assert.equal(row.v, "old", "checksum 失败后旧数据库记录必须保留");
  } finally {
    live.close();
  }
  local.close();
});

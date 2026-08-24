/**
 * Task 11 RED：完整对象集合、大视频零 PUT、账号即梦表隔离、N+1 只清 captured。
 * 必须打到生产 inventory / publish / journal，失败值是错误对象或错误合同。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import type { CentralAuthGateway, CentralSession } from "../../src/tianjiang/auth/central-session";
import { projectDirectory } from "../../src/tianjiang/data/paths";
import { ProjectStore } from "../../src/tianjiang/data/project-store";
import { writeProjectFileAtomic } from "../../src/tianjiang/media/project-file-store";
import * as inventory from "../../src/tianjiang/media/project-file-inventory";
import { CentralRuntimeAdapter } from "../../src/tianjiang/runtime/central-runtime-adapter";
import { RuntimeProjectLocal } from "../../src/tianjiang/runtime/project-runtime-local";
import {
  activateUserDatabase,
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
  db as activeDb,
} from "../../src/utils/db";
import {
  currentUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";
import {
  clearPendingMutationJournalOnFile,
  hasPendingMutationJournal,
  maxPendingMutationGeneration,
} from "../../src/tianjiang/runtime/legacy-mutation-journal";
import getPath from "../../src/utils/getPath";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9801 };
const PROJECT = "11111111-1111-4111-a111-111111111111";

function md5Of(bytes: Buffer): string {
  return crypto.createHash("md5").update(bytes).digest("hex");
}

test("完整对象集合必须包含 sqlite 与受管媒体，并拒绝账号即梦路径", () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-sync-inv-${Date.now()}`);
  fs.mkdirSync(path.join(root, "files", "images"), { recursive: true });
  fs.mkdirSync(path.join(root, "files", "videos"), { recursive: true });
  fs.mkdirSync(path.join(root, "files", "staging"), { recursive: true });
  const sqlitePath = path.join(root, "project.sqlite");
  const imagePath = path.join(root, "files", "images", "a.png");
  const videoPath = path.join(root, "files", "videos", "b.mp4");
  const planted = path.join(root, "files", "staging", "o_dreaminaCliDispatch.sqlite");
  fs.writeFileSync(sqlitePath, "sqlite");
  fs.writeFileSync(imagePath, "img");
  fs.writeFileSync(videoPath, "vid");
  fs.writeFileSync(planted, "account-table");
  try {
    const objects = inventory.buildCompleteProjectObjectSet({
      projectRoot: root,
      sqlitePath,
      sqliteMd5: md5Of(Buffer.from("sqlite")),
      sqliteSize: Buffer.byteLength("sqlite"),
    });
    const paths = objects.map((item) => item.relativePath);
    assert.ok(paths.includes("project.sqlite"));
    assert.ok(paths.includes("files/images/a.png"));
    assert.ok(paths.includes("files/videos/b.mp4"));
    assert.equal(paths.some((item) => item.includes("o_dreaminaCli")), false, `账号即梦表不得进入清单: ${paths.join(",")}`);
    assert.equal(paths.some((item) => item.includes("staging/")), false);
    assert.equal(inventory.isAllowedStoryboardSyncPath("o_dreaminaCliDispatch"), false);
    assert.equal(inventory.isAllowedStoryboardSyncPath("runtime-users/db2.sqlite"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("只改任务状态时未变化大视频必须零 PUT", async () => {
  const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-0000000000d8";
  const deviceUuid = "018f3d6e-2d9e-7b6c-8a9b-1234567890d8";
  const userSegment = "d8".repeat(16);
  const dataRoot = fs.mkdtempSync(path.resolve(process.cwd(), "..", ".tmp", "sb-zero-put-"));
  const videoBytes = Buffer.alloc(256 * 1024, 9);
  const videoMd5 = md5Of(videoBytes);
  const session = {
    id: "session",
    serverUrl: "https://api.example.invalid",
    token: "memory-only",
    expiresAt: Date.now() + 60_000,
    validatedAt: Date.now(),
    user: { id: 18, username: "zero", nickname: "Zero" },
  } as CentralSession;

  const store = new ProjectStore(dataRoot, projectUuid, "readwrite", userSegment);
  store.setRecord("runtime", "seed", { ok: true });
  store.close();
  writeProjectFileAtomic(dataRoot, projectUuid, userSegment, "files/videos/large.mp4", videoBytes);
  const local = new RuntimeProjectLocal(dataRoot, projectUuid, userSegment);
  await local.install(false);
  local.current = {
    version: 1,
    objects: [{ relativePath: "project.sqlite", size: 1, md5: "0".repeat(32) }],
  };
  local.setWritable();
  const baseSnapshot = await local.createSnapshot();
  const baseVideo = baseSnapshot.objects.find((item) => item.relativePath === "files/videos/large.mp4");
  assert.ok(baseVideo, "清单必须包含大视频");
  assert.equal(baseVideo.md5, videoMd5);
  local.current = {
    version: 1,
    objects: structuredClone(baseSnapshot.objects),
    installedDatabaseMD5: baseSnapshot.objects.find((item) => item.relativePath === "project.sqlite")!.md5,
  };
  fs.writeFileSync(
    path.join(projectDirectory(dataRoot, projectUuid, userSegment), ".tianjiang-manifest.json"),
    JSON.stringify(local.current, null, 2),
  );
  local.setRecord("runtime", "task-status", { n: 2 });
  local.dirty = true;
  const nextSnapshot = await local.createSnapshot();
  const putBodies: string[] = [];
  const gateway = {
    forwardBusinessRequest: async (
      _s: CentralSession,
      pathname: string,
      _m: string,
      body: Record<string, unknown> = {},
    ) => {
      if (pathname.endsWith("/upload-sessions")) {
        const objects = body.objects as Array<{ relativePath: string; size: number; md5: string }>;
        const required = objects.filter((item) => !(
          item.relativePath === "files/videos/large.mp4"
          && item.md5 === videoMd5
          && item.size === videoBytes.length
        ));
        return {
          sessionUuid: "018f3d6e-2d9e-7b6c-8a9b-0000000000e8",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          objects: required.map((item) => ({
            relativePath: item.relativePath,
            size: item.size,
            md5: item.md5,
            objectKey: `staging/${item.relativePath}`,
            verified: false,
          })),
          requiredUploadObjects: required.map((item) => item.relativePath),
        };
      }
      if (pathname.endsWith("/object-authorizations")) {
        const rel = String(body.relativePath);
        const obj = nextSnapshot.objects.find((item) => item.relativePath === rel)!;
        return {
          url: `https://oss.example.invalid/put/${encodeURIComponent(rel)}?sig=x`,
          signedHeaders: { "Content-Md5": Buffer.from(obj.md5, "hex").toString("base64") },
        };
      }
      if (pathname.endsWith("/objects/confirm")) return {};
      if (pathname.endsWith("/commit")) {
        return { version: 2, manifest: body.manifest, objects: [] };
      }
      if (pathname.endsWith("/fail")) return {};
      throw new Error(`未预期 ${pathname}`);
    },
  } as unknown as CentralAuthGateway;
  const transport = async (input: string | URL | Request) => {
    const url = String(input);
    const match = /put\/([^?]+)/.exec(url);
    if (match) putBodies.push(decodeURIComponent(match[1]!));
    return new Response(null, { status: 200 });
  };
  const adapter = new CentralRuntimeAdapter(gateway, session, deviceUuid, transport as typeof fetch);
  const remote = adapter.personalRemote(projectUuid, () => undefined, {
    currentVersion: 1,
    readObject: (p, e) => local.readSyncObject(p, e),
    resolveObjectPath: (p, e) => local.resolveSyncObjectPath(p, e),
  });
  try {
    const committed = await remote.publish(1, nextSnapshot, undefined as never, "manual");
    assert.equal(committed.version, 2);
    assert.equal(
      putBodies.includes("files/videos/large.mp4"),
      false,
      `未变化大视频不得 PUT，实际上传=${putBodies.join(",")}`,
    );
    assert.ok(
      putBodies.some((item) => item === "project.sqlite" || item.includes("project.sqlite")),
      `必须上传变化的 sqlite，实际=${putBodies.join(",")}`,
    );
  } finally {
    local.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("N+1 新分镜必须在只清 captured 后保持 pending", async () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", `sb-nplus1-${Date.now()}`);
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);
  try {
    await runWithUserStorage(IDENTITY, async () => {
      await initializeWorkspaceProject(PROJECT, {
        id: 81,
        name: "N+1",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });
      const service = new StoryboardService(PROJECT);
      await service.insertShot({ afterShotUuid: null, sourceText: "第一镜" });
      const captured = await runWithProjectStorage(PROJECT, () => maxPendingMutationGeneration(activeDb as any));
      assert.ok(captured && captured > 0, "第一镜必须产生 captured generation");
      await service.insertShot({ afterShotUuid: null, sourceText: "第二镜" });
      const segment = currentUserStorage()!.segment;
      const dbPath = path.join(projectDirectory(getPath(), PROJECT, segment), "project.sqlite");
      const cleared = clearPendingMutationJournalOnFile(dbPath, { captured: captured! });
      assert.ok(cleared.remainingPending > 0, `N+1 必须仍 pending，实际 remaining=${cleared.remainingPending}`);
      const still = await runWithProjectStorage(PROJECT, () => hasPendingMutationJournal(activeDb as any));
      assert.equal(still, true, "新分镜不得随 captured 一并清除");
    });
  } finally {
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

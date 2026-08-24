/**
 * Round10：中央权威增量上传。
 * 只修改 sqlite 时不得上传未变化的大视频对象。
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
import { CentralRuntimeAdapter } from "../../src/tianjiang/runtime/central-runtime-adapter";
import { RuntimeProjectLocal } from "../../src/tianjiang/runtime/project-runtime-local";

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-0000000000d1";
const deviceUuid = "018f3d6e-2d9e-7b6c-8a9b-1234567890d1";
const userSegment = "d1".repeat(16);
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

const session = {
  id: "session",
  serverUrl: "https://api.example.invalid",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 11, username: "inc", nickname: "Inc" },
} as CentralSession;

function md5Of(bytes: Buffer): string {
  return crypto.createHash("md5").update(bytes).digest("hex");
}

test("只修改 project.sqlite 时服务端 requiredUploadObjects 不含旧视频，客户端零上传该视频", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-incr-upload-"));
  const videoBytes = Buffer.alloc(256 * 1024, 7); // 256KB 旧视频
  const videoMd5 = md5Of(videoBytes);

  const store = new ProjectStore(dataRoot, projectUuid, "readwrite", userSegment);
  store.setRecord("runtime", "seed", { ok: true });
  store.close();
  writeProjectFileAtomic(
    dataRoot,
    projectUuid,
    userSegment,
    "files/videos/large.mp4",
    videoBytes,
  );
  const projectRoot = projectDirectory(dataRoot, projectUuid, userSegment);

  // 建立 v1 基线：sqlite + video
  const local = new RuntimeProjectLocal(dataRoot, projectUuid, userSegment);
  await local.install(false);
  local.current = {
    version: 1,
    objects: [{ relativePath: "project.sqlite", size: 1, md5: "0".repeat(32) }],
  };
  local.setWritable();
  const baseSnapshot = await local.createSnapshot();
  const baseVideo = baseSnapshot.objects.find((o) => o.relativePath === "files/videos/large.mp4")!;
  assert.ok(baseVideo);
  assert.equal(baseVideo.md5, videoMd5);
  local.current = {
    version: 1,
    objects: structuredClone(baseSnapshot.objects),
    installedDatabaseMD5: baseSnapshot.objects.find((o) => o.relativePath === "project.sqlite")!.md5,
  };
  fs.writeFileSync(
    path.join(projectRoot, ".tianjiang-manifest.json"),
    JSON.stringify(local.current, null, 2),
  );

  // 仅修改 sqlite
  local.setRecord("runtime", "mutation", { n: 2 });
  local.dirty = true;
  const nextSnapshot = await local.createSnapshot();
  assert.ok(
    nextSnapshot.objects.some((o) => o.relativePath === "files/videos/large.mp4" && o.md5 === videoMd5),
    "候选清单必须仍含未变化视频",
  );
  assert.ok(
    nextSnapshot.objects.find((o) => o.relativePath === "project.sqlite")!.md5
      !== local.current!.installedDatabaseMD5,
    "sqlite 必须已变化",
  );

  const putBodies: string[] = [];
  const sessionObjectsReturned: string[] = [];
  let plannedObjectsCount = 0;

  const gateway = {
    forwardBusinessRequest: async (
      _s: CentralSession,
      pathname: string,
      _m: string,
      body: Record<string, unknown> = {},
    ) => {
      if (pathname.endsWith("/upload-sessions")) {
        const objects = body.objects as Array<{ relativePath: string; size: number; md5: string }>;
        plannedObjectsCount = objects.length;
        // 中央权威增量：对比 baseVersion=1，未变化视频不进入 required
        const required = objects.filter((o) => {
          if (
            o.relativePath === "files/videos/large.mp4"
            && o.md5 === videoMd5
            && o.size === videoBytes.length
          ) {
            return false;
          }
          return true;
        });
        sessionObjectsReturned.push(...required.map((o) => o.relativePath));
        return {
          sessionUuid: "018f3d6e-2d9e-7b6c-8a9b-0000000000e1",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          objects: required.map((o) => ({
            relativePath: o.relativePath,
            size: o.size,
            md5: o.md5,
            objectKey: `staging/${o.relativePath}`,
            verified: false,
          })),
          requiredUploadObjects: required.map((o) => o.relativePath),
        };
      }
      if (pathname.endsWith("/object-authorizations")) {
        const rel = String(body.relativePath);
        const obj = nextSnapshot.objects.find((o) => o.relativePath === rel)!;
        return {
          url: `https://oss.example.invalid/put/${encodeURIComponent(rel)}?sig=x`,
          signedHeaders: {
            "Content-Md5": Buffer.from(obj.md5, "hex").toString("base64"),
          },
        };
      }
      if (pathname.endsWith("/objects/confirm")) return {};
      if (pathname.endsWith("/commit")) {
        const manifest = body.manifest as { files?: Array<{ relative_path: string }> };
        assert.ok(
          Array.isArray(manifest.files)
            && manifest.files.some((f) => f.relative_path === "files/videos/large.mp4"),
          "commit 清单必须仍引用未变化视频",
        );
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

  const adapter = new CentralRuntimeAdapter(
    gateway,
    session,
    deviceUuid,
    transport as typeof fetch,
  );
  const remote = adapter.personalRemote(projectUuid, () => undefined, {
    currentVersion: 1,
    readObject: (p, e) => local.readSyncObject(p, e),
    resolveObjectPath: (p, e) => local.resolveSyncObjectPath(p, e),
  });

  try {
    // 生产路径：adapter.publish 只上传 requiredUploadObjects
    const committed = await remote.publish(1, nextSnapshot, undefined as never, "manual");
    assert.equal(committed.version, 2);
    assert.ok(plannedObjectsCount >= 2, "客户端应提交完整候选清单（含未变化视频）");
    assert.ok(
      !putBodies.includes("files/videos/large.mp4"),
      `未变化视频不得 PUT，实际上传=${putBodies.join(",")}`,
    );
    assert.ok(
      putBodies.some((p) => p === "project.sqlite" || p.includes("project.sqlite")),
      `必须上传变化的 sqlite，实际=${putBodies.join(",")}`,
    );
    assert.ok(
      !sessionObjectsReturned.includes("files/videos/large.mp4"),
      "requiredUploadObjects 不得包含未变化视频",
    );
  } finally {
    local.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

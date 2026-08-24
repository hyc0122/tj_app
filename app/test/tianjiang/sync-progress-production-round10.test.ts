/**
 * Round10 RED：进度必须来自生产 coordinator/adapter 真实事件，禁止直接 store.update 冒充。
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
import { syncProgressStore } from "../../src/tianjiang/runtime/sync-progress";
import { PersonalProjectSync } from "../../src/tianjiang/sync/personal-project-sync";

const projectUuid = "018f3d6e-2d9e-7b6c-8a9b-0000000000b1";
const deviceUuid = "018f3d6e-2d9e-7b6c-8a9b-1234567890b1";
const userSegment = "b1".repeat(16);
const workspaceTempRoot = path.resolve(__dirname, "../../../.tmp");
fs.mkdirSync(workspaceTempRoot, { recursive: true });

const session = {
  id: "session",
  serverUrl: "https://api.example.invalid",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 9, username: "progress", nickname: "Progress" },
} as CentralSession;

function md5Of(bytes: Buffer): string {
  return crypto.createHash("md5").update(bytes).digest("hex");
}

test("publish 路径必须推进 uploading 对象/字节进度与分类计数，且不得只手工 store.update", async () => {
  const dataRoot = fs.mkdtempSync(path.join(workspaceTempRoot, "tj-progress-prod-"));
  const store = new ProjectStore(dataRoot, projectUuid, "readwrite", userSegment);
  store.setRecord("runtime", "seed", { ok: true });
  store.close();
  const projectRoot = projectDirectory(dataRoot, projectUuid, userSegment);
  fs.writeFileSync(path.join(projectRoot, ".tianjiang-manifest.json"), JSON.stringify({
    version: 0,
    objects: [],
  }));
  const image = Buffer.from("progress-image-bytes");
  const video = Buffer.from("progress-video-bytes-longer");
  writeProjectFileAtomic(dataRoot, projectUuid, userSegment, "files/images/a.png", image);
  writeProjectFileAtomic(dataRoot, projectUuid, userSegment, "files/videos/b.mp4", video);

  const local = new RuntimeProjectLocal(dataRoot, projectUuid, userSegment);
  await local.install(false);
  local.dirty = true;

  const uploadedPaths: string[] = [];
  const gateway = {
    forwardBusinessRequest: async (
      _s: CentralSession,
      pathname: string,
      _method: string,
      body: Record<string, unknown> = {},
    ) => {
      if (pathname.endsWith("/upload-sessions")) {
        const objects = body.objects as Array<{ relativePath: string; size: number; md5: string }>;
        return {
          sessionUuid: "018f3d6e-2d9e-7b6c-8a9b-0000000000c1",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          // 中央权威增量：返回需要上传的对象（本轮全部）
          objects: objects.map((o) => ({
            relativePath: o.relativePath,
            size: o.size,
            md5: o.md5,
            objectKey: `staging/${o.relativePath}`,
            verified: false,
          })),
          requiredUploadObjects: objects.map((o) => o.relativePath),
        };
      }
      if (pathname.endsWith("/object-authorizations")) {
        return {
          url: `https://oss.example.invalid/upload/${(body as { relativePath: string }).relativePath}?signature=redacted`,
          signedHeaders: {
            "Content-Md5": Buffer.from(
              String((body as { contentMd5?: string }).contentMd5 ?? "00"),
              "base64",
            ).length
              ? { "Content-Md5": "placeholder" }
              : {},
          },
        };
      }
      if (pathname.endsWith("/objects/confirm")) return {};
      if (pathname.endsWith("/commit")) {
        return { version: 1, manifest: body.manifest, objects: [] };
      }
      if (pathname.endsWith("/fail")) return {};
      throw new Error(`未预期：${pathname}`);
    },
  } as unknown as CentralAuthGateway;

  // 修正 signed headers：按真实 md5 生成
  const gatewayFixed = {
    forwardBusinessRequest: async (
      sessionArg: CentralSession,
      pathname: string,
      method: string,
      body: Record<string, unknown> = {},
    ) => {
      if (pathname.endsWith("/object-authorizations") && body.method === "PUT") {
        const rel = String(body.relativePath);
        const snapshot = await local.createSnapshot();
        const obj = snapshot.objects.find((o) => o.relativePath === rel)!;
        const contentMD5 = Buffer.from(obj.md5, "hex").toString("base64");
        return {
          url: `https://oss.example.invalid/upload/${encodeURIComponent(rel)}?signature=redacted`,
          signedHeaders: { "Content-Md5": contentMD5 },
        };
      }
      return (gateway as { forwardBusinessRequest: typeof gatewayFixed.forwardBusinessRequest })
        .forwardBusinessRequest(sessionArg, pathname, method, body);
    },
  } as unknown as CentralAuthGateway;

  // 简化：自包含 gateway
  const snapshotOnce = await local.createSnapshot();
  local.dirty = true;
  const objectMap = new Map(snapshotOnce.objects.map((o) => [o.relativePath, o]));
  const fullGateway = {
    forwardBusinessRequest: async (
      _s: CentralSession,
      pathname: string,
      _m: string,
      body: Record<string, unknown> = {},
    ) => {
      if (pathname.endsWith("/upload-sessions")) {
        const objects = body.objects as Array<{ relativePath: string; size: number; md5: string }>;
        return {
          sessionUuid: "018f3d6e-2d9e-7b6c-8a9b-0000000000c1",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          objects: objects.map((o) => ({
            relativePath: o.relativePath,
            size: o.size,
            md5: o.md5,
            objectKey: `staging/${o.relativePath}`,
            verified: false,
          })),
          requiredUploadObjects: objects.map((o) => o.relativePath),
        };
      }
      if (pathname.endsWith("/object-authorizations")) {
        const rel = String(body.relativePath);
        const obj = objectMap.get(rel)!;
        return {
          url: `https://oss.example.invalid/upload/${encodeURIComponent(rel)}?signature=redacted`,
          signedHeaders: {
            "Content-Md5": Buffer.from(obj.md5, "hex").toString("base64"),
          },
        };
      }
      if (pathname.endsWith("/objects/confirm")) return {};
      if (pathname.endsWith("/commit")) return { version: 1, manifest: body.manifest, objects: [] };
      if (pathname.endsWith("/fail")) return {};
      throw new Error(`未预期：${pathname}`);
    },
  } as unknown as CentralAuthGateway;

  const transport = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const match = /upload\/([^?]+)/.exec(url);
    if (match) uploadedPaths.push(decodeURIComponent(match[1]!));
    return new Response(null, { status: 200 });
  };

  syncProgressStore.clear();
  const operationId = `manual-${projectUuid}`;
  syncProgressStore.begin({
    operationId,
    intent: "manual",
    totalProjects: 1,
    projectUuid,
    projectName: "进度项目",
    projectKind: "personal",
  });

  const adapter = new CentralRuntimeAdapter(
    fullGateway,
    session,
    deviceUuid,
    transport as typeof fetch,
  );
  // 生产应接受 progress 回调 / operationId
  const remote = adapter.personalRemote(projectUuid, () => undefined, {
    currentVersion: 0,
    readObject: (relativePath, expected) => local.readSyncObject(relativePath, expected),
  });
  // 若 adapter 支持 setProgressSink
  if (typeof (adapter as { bindProgress?: unknown }).bindProgress === "function") {
    (adapter as { bindProgress: (id: string) => void }).bindProgress(operationId);
  } else if (
    typeof (remote as unknown as { setProgressOperationId?: unknown }).setProgressOperationId === "function"
  ) {
    (remote as unknown as { setProgressOperationId: (id: string) => void })
      .setProgressOperationId(operationId);
  }

  const sync = new PersonalProjectSync(local, remote, () => true);
  sync.open();

  try {
    await sync.sync("manual");
    const snap = syncProgressStore.get();
    assert.ok(
      snap.completedObjects >= 2 || snap.uploadedBytes > 0,
      `必须有真实对象/字节进度，实际 completedObjects=${snap.completedObjects} uploadedBytes=${snap.uploadedBytes} phase=${snap.phase}`,
    );
    assert.ok(
      (snap.counts.image ?? 0) + (snap.counts.video ?? 0) + (snap.counts.database ?? 0) >= 2
        || snap.totalObjects >= 2,
      `必须统计分类或 totalObjects，counts=${JSON.stringify(snap.counts)} totalObjects=${snap.totalObjects}`,
    );
    assert.ok(uploadedPaths.length >= 1, "必须真实上传对象");
  } finally {
    local.close();
    syncProgressStore.clear();
    fs.rmSync(dataRoot, { recursive: true, force: true });
    void gatewayFixed;
    void md5Of;
  }
});

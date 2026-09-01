/**
 * 画布崩溃/HTTP 夹具：只依赖上一阶段已提交入口，禁止 import 尚未创建的素材模块。
 */
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import express from "express";
import http from "node:http";
import path from "node:path";

export const ONE_PIXEL_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function md5Hex(value: Buffer): string {
  return crypto.createHash("md5").update(value).digest("hex");
}

/** RFC 8785 的最小可用实现：递归键排序后 JSON.stringify。 */
export function canonicalizeJcs(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) next[key] = sortCanonical(record[key]);
    return next;
  }
  return value;
}

export function canvasCatalogItem(projectUuid: string, name = "画布项目") {
  return {
    projectUuid,
    name,
    kind: "personal",
    ownerUserId: 7601,
    role: "owner",
    myRole: "owner",
    currentVersion: 0,
    syncState: "local_only",
    lastSyncedAt: null,
    updatedAt: new Date().toISOString(),
    lockStatus: "none",
    lockHolderName: "",
    openMode: "editable",
    businessType: "canvas",
  };
}

export const canvasOwnerSession = {
  id: "sess-canvas-assets",
  serverUrl: "https://api.j11.com.cn",
  token: "memory-only",
  expiresAt: Date.now() + 60_000,
  validatedAt: Date.now(),
  user: { id: 7601, username: "canvas-owner" },
};

export async function listenExpress(app: express.Express): Promise<{ server: http.Server; port: number }> {
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, port };
}

export async function mountCanvasRuntimeApp(session = canvasOwnerSession): Promise<{
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}> {
  const { setCanvasPlannerAdapterForTests } = await import("../../../src/tianjiang/canvas/canvas-plan-service");
  const { setCanvasExecutionModelResolverForTests } = await import("../../../src/tianjiang/canvas/canvas-execution-service");
  const { setCanvasExecutionWorkerAdapterForTests } = await import("../../../src/tianjiang/canvas/canvas-execution-worker");
  setCanvasPlannerAdapterForTests(async (input) => ({
    summary: input.prompt,
    nodes: [{
      clientKey: "text-1",
      kind: "text",
      title: input.prompt.slice(0, 80),
      text: input.prompt,
    }],
    edges: [],
  }));
  setCanvasExecutionModelResolverForTests(async ({ modelId, mediaType }) => ({
    modelId: modelId || `fixture:${mediaType}-model`,
    providerId: "fixture",
    deploymentKey: modelId || `fixture:${mediaType}-model`,
    credentialSlotId: "fixture",
  }));
  setCanvasExecutionWorkerAdapterForTests(async () => "deferred");
  const { default: runtimeRouter } = await import("../../../src/routes/tianjiang/runtime");
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    (req as { centralSession?: unknown }).centralSession = session;
    next();
  });
  app.use("/api/tianjiang/runtime", runtimeRouter);
  const { server, port } = await listenExpress(app);
  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => {
      setCanvasExecutionModelResolverForTests(undefined);
      setCanvasExecutionWorkerAdapterForTests(undefined);
      resolve();
    })),
  };
}

export async function stubOpenedCanvas(projectUuid: string, extra: Record<string, unknown> = {}): Promise<void> {
  const { syncCoordinator } = await import("../../../src/tianjiang/runtime/runtime");
  Object.assign(syncCoordinator, {
    listProjects: () => [canvasCatalogItem(projectUuid, String(extra.name ?? "画布项目"))],
    isProjectOpened: (uuid: string) => uuid === projectUuid,
  });
}

export function assetUploadDigest(projectUuid: string, file: Buffer, mimeType: string): string {
  return sha256Hex(canonicalizeJcs({
    operation: "asset-upload",
    projectUuid,
    sha256: sha256Hex(file),
    sizeBytes: file.length,
    mimeType,
  }));
}

export function assetDeleteDigest(projectUuid: string, assetUuid: string, expectedSha256: string): string {
  return sha256Hex(canonicalizeJcs({
    operation: "asset-delete",
    projectUuid,
    assetUuid,
    expectedSha256,
  }));
}

export function tjcanvasImportDigest(input: {
  projectUuid: string;
  archiveSha256: string;
  archiveSizeBytes: number;
  baseRevision: number;
  importerSchemaVersion: number;
}): string {
  return sha256Hex(canonicalizeJcs({
    operation: "tjcanvas-import",
    targetProjectUuid: input.projectUuid,
    archiveSha256: input.archiveSha256,
    archiveSizeBytes: input.archiveSizeBytes,
    baseRevision: input.baseRevision,
    importerSchemaVersion: input.importerSchemaVersion,
  }));
}

/** STORE 方式 ZIP，测试夹具禁止落盘 GiB 文件。 */
export function zipStore(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    const payload = Buffer.concat([local, entry.data]);
    locals.push(payload);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += payload.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const take = crc & 1;
      crc >>>= 1;
      if (take) crc ^= 0xedb88320;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function spawnCanvasCrashChild(env: Record<string, string>): ChildProcess {
  const fixture = path.resolve(
    __dirname,
    "..",
    "fixtures",
    "canvas-crash-child.ts",
  );
  return spawn(process.execPath, ["--import", "tsx", fixture], {
    env: { ...process.env, ...env },
    stdio: "ignore",
    windowsHide: true,
  });
}

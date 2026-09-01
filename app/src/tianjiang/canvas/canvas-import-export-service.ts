import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import compressing from "compressing";
import zlib from "node:zlib";

import { acquireProjectDatabaseLease, db, releaseProjectDatabaseLease } from "@/utils/db";
import getPath from "@/utils/getPath";
import {
  CANVAS_IMPORTER_SCHEMA_VERSION,
  CANVAS_LIMITS,
  CANVAS_PORTABLE_FORMAT_VERSION,
} from "../contracts";
import { parseRestrictedMultipart } from "../media/restricted-multipart";
import { streamProjectFileFromBuffer } from "../media/stream-project-file";
import { upsertPendingMutationJournalInTrx } from "../runtime/legacy-mutation-journal";
import { withProjectMutationGate } from "../runtime/project-mutation-gate";
import { currentUserStorage, runWithProjectStorage } from "../runtime/user-storage-context";
import { emptyCanvasDocument, type CanvasDocument } from "./canvas-contracts";
import { CanvasRuntimeError, readCanvasDocument, saveCanvasDocument, sha256Text, type CanvasDocumentEnvelope } from "./canvas-document-service";
import { releaseCanvasImportStaging, reserveCanvasImportStaging } from "./canvas-import-staging-reservation-store";

const STRIP_KEYS = new Set(["runUuid", "taskUuid", "confirmationUuid", "currentRun", "latestRun"]);

function remapUuid(source: string, mapped: Map<string, string>): string {
  const existing = mapped.get(source);
  if (existing) return existing;
  const next = crypto.randomUUID();
  mapped.set(source, next);
  return next;
}

function stripIdentity(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripIdentity);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (STRIP_KEYS.has(key)) continue;
    result[key] = stripIdentity(item);
  }
  return result;
}

export function remapImportedDocument(document: CanvasDocument): CanvasDocument {
  const mapped = new Map<string, string>();
  const nodes = (document.graph?.nodes ?? []).map((node) => {
    const record = { ...(node as Record<string, unknown>) };
    const oldId = String(record.nodeUuid ?? crypto.randomUUID());
    record.nodeUuid = remapUuid(oldId, mapped);
    if (typeof record.parentNodeUuid === "string" && record.parentNodeUuid) {
      record.parentNodeUuid = remapUuid(record.parentNodeUuid, mapped);
    }
    record.data = stripIdentity(record.data ?? {});
    return record;
  });
  const edges = (document.graph?.edges ?? []).map((edge) => {
    const record = { ...(edge as Record<string, unknown>) };
    record.edgeUuid = crypto.randomUUID();
    if (typeof record.sourceNodeUuid === "string") {
      record.sourceNodeUuid = remapUuid(record.sourceNodeUuid, mapped);
    }
    if (typeof record.targetNodeUuid === "string") {
      record.targetNodeUuid = remapUuid(record.targetNodeUuid, mapped);
    }
    return record;
  });
  return {
    schemaVersion: 1,
    graph: { nodes, edges },
    viewport: document.viewport ?? emptyCanvasDocument().viewport,
    preferences: document.preferences ?? emptyCanvasDocument().preferences,
  };
}

export async function importCanvasJson(
  projectUuid: string,
  input: { baseRevision: number; clientMutationId: string; document: CanvasDocument },
): Promise<CanvasDocumentEnvelope> {
  const remapped = remapImportedDocument(input.document ?? emptyCanvasDocument());
  return saveCanvasDocument(projectUuid, {
    baseRevision: input.baseRevision,
    clientMutationId: input.clientMutationId,
    document: remapped,
  });
}

export async function importCanvasNovel(
  projectUuid: string,
  input: { baseRevision: number; clientMutationId: string; text: string },
): Promise<CanvasDocumentEnvelope> {
  const document = emptyCanvasDocument();
  document.graph.nodes = [{
    nodeUuid: crypto.randomUUID(),
    kind: "file",
    position: { x: 40, y: 40 },
    zIndex: 1,
    collapsed: false,
    data: { title: "小说原文", text: String(input.text ?? "").slice(0, 200_000) },
  }];
  return saveCanvasDocument(projectUuid, {
    baseRevision: input.baseRevision,
    clientMutationId: input.clientMutationId,
    document,
  });
}

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

export function tjcanvasImportDigest(input: {
  projectUuid: string;
  archiveSha256: string;
  archiveSizeBytes: number;
  baseRevision: number;
  importerSchemaVersion: number;
}): string {
  return sha256Text(canonicalizeJcs({
    operation: "tjcanvas-import",
    targetProjectUuid: input.projectUuid,
    archiveSha256: input.archiveSha256,
    archiveSizeBytes: input.archiveSizeBytes,
    baseRevision: input.baseRevision,
    importerSchemaVersion: input.importerSchemaVersion,
  }));
}

export async function exportCanvasPortable(projectUuid: string): Promise<Buffer> {
  return withProjectMutationGate(projectUuid, async () => {
    const envelope = await readCanvasDocument(projectUuid);
    const documentBytes = Buffer.from(canonicalizeJcs(envelope.document), "utf8");
    const assets = await db("canvas_assets").where({ lifecycle_state: "ready" });
    const ctx = currentUserStorage();
    if (!ctx?.segment) {
      throw new CanvasRuntimeError("PERMISSION_DENIED", "项目不存在或不可见", 403, false);
    }
    const projectRoot = path.join(getPath(), "runtime-users", ctx.segment, "projects", projectUuid);
    const verifiedAssets = [] as Array<{
      row: Record<string, unknown>;
      absolutePath: string;
      entryName: string;
    }>;
    for (const row of assets) {
      const relativePath = String(row.relative_path).replace(/\\/g, "/");
      const absolutePath = path.resolve(projectRoot, ...relativePath.split("/"));
      if (!absolutePath.startsWith(path.resolve(projectRoot) + path.sep)) {
        throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "素材路径越界", 422, false);
      }
      const stat = fs.statSync(absolutePath);
      const digest = await sha256File(absolutePath);
      if (stat.size !== Number(row.size_bytes) || digest !== String(row.sha256)) {
        throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "素材文件与索引不一致", 409, true);
      }
      verifiedAssets.push({
        row,
        absolutePath,
        entryName: `assets/sha256/${digest}`,
      });
    }
    const manifest = {
      formatVersion: CANVAS_PORTABLE_FORMAT_VERSION,
      importerSchemaVersion: CANVAS_IMPORTER_SCHEMA_VERSION,
      documentEntryName: "document.json",
      documentSha256: crypto.createHash("sha256").update(documentBytes).digest("hex"),
      assets: verifiedAssets.map(({ row, entryName }) => ({
        sourceAssetUuid: String(row.asset_uuid),
        sourceAssetKey: `asset/${row.asset_uuid}`,
        entryName,
        mimeType: String(row.mime_type),
        sizeBytes: Number(row.size_bytes),
        sha256: String(row.sha256),
      })).sort((left, right) =>
        left.sourceAssetKey.localeCompare(right.sourceAssetKey)
        || left.sourceAssetUuid.localeCompare(right.sourceAssetUuid),
      ),
    };
    const zipStream = new compressing.zip.Stream();
    zipStream.addEntry(documentBytes, { relativePath: "document.json" });
    zipStream.addEntry(Buffer.from(canonicalizeJcs(manifest), "utf8"), { relativePath: "manifest.json" });
    const addedEntries = new Set<string>();
    for (const asset of verifiedAssets) {
      if (addedEntries.has(asset.entryName)) continue;
      addedEntries.add(asset.entryName);
      // 中文注释：素材使用文件流写入归档，避免未打开画布素材长期驻留进程内存。
      zipStream.addEntry(fs.createReadStream(asset.absolutePath), { relativePath: asset.entryName });
    }
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      zipStream.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      zipStream.on("end", () => resolve());
      zipStream.on("error", reject);
    });
    return Buffer.concat(chunks);
  });
}

async function sha256File(absolutePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

export async function acceptCanvasTjcanvasImport(
  req: IncomingMessage,
  projectUuid: string,
): Promise<{
  importUuid: string;
  projectUuid: string;
  clientMutationId: string;
  requestDigest: string;
  state: string;
  acceptedAt: string;
}> {
  const parsed = await parseRestrictedMultipart(req, {
    maxFileBytes: CANVAS_LIMITS.MAX_CANVAS_MULTIPART_FILE_BYTES,
    maxFiles: 1,
    maxTotalBytes: CANVAS_LIMITS.MAX_CANVAS_MULTIPART_TOTAL_BYTES,
  });
  const baseRevision = Number(parsed.fields.baseRevision);
  const clientMutationId = String(parsed.fields.clientMutationId ?? "");
  const requestDigest = String(parsed.fields.requestDigest ?? "");
  const archiveSha256 = String(parsed.fields.archiveSha256 ?? "");
  const archiveSizeBytes = Number(parsed.fields.archiveSizeBytes);
  const file = parsed.files[0];
  if (!Number.isInteger(baseRevision) || !/^[0-9a-f-]{36}$/i.test(clientMutationId)) {
    throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "便携画布导入请求不合法", 422, false);
  }
  const expected = tjcanvasImportDigest({
    projectUuid,
    archiveSha256,
    archiveSizeBytes,
    baseRevision,
    importerSchemaVersion: CANVAS_IMPORTER_SCHEMA_VERSION,
  });
  if (expected !== requestDigest) {
    throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "便携画布导入请求不合法", 422, false);
  }
  await reserveCanvasImportStaging({
    projectUuid,
    clientMutationId,
    archiveSizeBytes,
  });
  return withProjectMutationGate(projectUuid, async () => {
    const existing = await db("canvas_import_jobs").where({
      client_mutation_id: clientMutationId,
    }).first();
    if (existing) {
      if (String(existing.request_digest) !== requestDigest) {
        throw new CanvasRuntimeError(
          "CANVAS_MUTATION_IDEMPOTENCY_CONFLICT",
          "相同文档变更 ID 的摘要与首次请求不一致",
          409,
          false,
        );
      }
      return JSON.parse(String(existing.acceptance_response_json));
    }
    if (!file?.buffer) {
      throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "便携画布导入请求不合法", 422, false);
    }
    const actualSha = crypto.createHash("sha256").update(file.buffer).digest("hex");
    if (actualSha !== archiveSha256 || file.buffer.length !== archiveSizeBytes) {
      throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "便携画布导入请求不合法", 422, false);
    }
    const ctx = currentUserStorage();
    if (!ctx?.segment) {
      throw new CanvasRuntimeError("PERMISSION_DENIED", "项目不存在或不可见", 403, false);
    }
    const importUuid = crypto.randomUUID();
    const stagingRelative = `.staging/canvas-imports/${importUuid}.tjcanvas`;
    await streamProjectFileFromBuffer({
      dataRoot: getPath(),
      projectUuid,
      userSegment: ctx.segment,
      relativePath: stagingRelative,
      data: file.buffer,
      maxBytes: CANVAS_LIMITS.MAX_CANVAS_MULTIPART_FILE_BYTES,
    });
    const now = new Date().toISOString();
    const receipt = {
      importUuid,
      projectUuid,
      clientMutationId,
      requestDigest,
      state: "queued",
      acceptedAt: now,
    };
    await db.transaction(async (trx) => {
      await trx("canvas_import_jobs").insert({
        import_uuid: importUuid,
        origin_device_uuid: "origin-device",
        client_mutation_id: clientMutationId,
        request_digest: requestDigest,
        archive_sha256: archiveSha256,
        archive_size_bytes: archiveSizeBytes,
        base_revision: baseRevision,
        importer_schema_version: CANVAS_IMPORTER_SCHEMA_VERSION,
        staging_relative_path: stagingRelative,
        state: "queued",
        lease_owner: null,
        lease_epoch: 1,
        lease_expires_at: null,
        attempt: 0,
        applied_revision: null,
        total_items: 0,
        validated_items: 0,
        moved_items: 0,
        staged_manifest_json: null,
        accepted_at: now,
        acceptance_response_json: JSON.stringify(receipt),
        terminal_response_json: null,
        failure_code: null,
        created_at: now,
        updated_at: now,
      });
      await upsertPendingMutationJournalInTrx(trx, "canvas:import-accept");
    });
    // 中文注释：HTTP 先返回不可变 receipt；同一进程随后消费，崩溃后由恢复扫描重新消费 queued 行。
    const importTimer = setTimeout(() => {
      void processCanvasImportJob(projectUuid, importUuid).catch(() => undefined);
    }, 500);
    importTimer.unref?.();
    return receipt;
  });
}

interface PortableZipEntry {
  name: string;
  bytes: Buffer;
}

interface PortableManifestAsset {
  sourceAssetUuid: string;
  sourceAssetKey: string;
  entryName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

interface PortableManifest {
  formatVersion: number;
  importerSchemaVersion: number;
  documentEntryName: string;
  documentSha256: string;
  assets: PortableManifestAsset[];
}

function importFailure(message: string): never {
  throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", message, 422, false);
}

/** 中文注释：先读中央目录再解压，禁止 zip-slip、加密条目、Zip64 与压缩炸弹。 */
function readPortableZipEntries(archive: Buffer): Map<string, Buffer> {
  const minimum = Math.max(0, archive.length - 65_557);
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) importFailure("归档缺少中央目录");
  const count = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (count > CANVAS_LIMITS.MAX_CANVAS_ARCHIVE_ENTRIES || centralOffset + centralSize > archive.length) {
    importFailure("归档条目数量或中央目录越界");
  }
  const entries = new Map<string, Buffer>();
  let cursor = centralOffset;
  let expandedTotal = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== 0x02014b50) {
      importFailure("归档中央目录损坏");
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const expandedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > archive.length || nameLength > CANVAS_LIMITS.MAX_CANVAS_ARCHIVE_PATH_BYTES) {
      importFailure("归档路径过长");
    }
    const name = archive.subarray(nameStart, nameEnd).toString("utf8");
    const parts = name.split("/");
    const allowed = name === "document.json"
      || name === "manifest.json"
      || /^assets\/sha256\/[0-9a-f]{64}$/.test(name);
    if (
      !allowed
      || name.includes("\\")
      || name.startsWith("/")
      || parts.some((part) => !part || part === "." || part === "..")
      || parts.length > CANVAS_LIMITS.MAX_CANVAS_ARCHIVE_PATH_DEPTH
      || (flags & 0x1) !== 0
      || ![0, 8].includes(method)
      || (externalAttributes & 0xf0000000) === 0xa0000000
      || expandedSize > CANVAS_LIMITS.MAX_CANVAS_ARCHIVE_ENTRY_BYTES
    ) {
      importFailure("归档包含不允许的条目");
    }
    expandedTotal += expandedSize;
    if (expandedTotal > CANVAS_LIMITS.MAX_CANVAS_ARCHIVE_UNCOMPRESSED_BYTES) {
      importFailure("归档解压大小超过上限");
    }
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      importFailure("归档本地条目损坏");
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archive.length) importFailure("归档条目数据越界");
    const compressed = archive.subarray(dataStart, dataEnd);
    const bytes = method === 0
      ? Buffer.from(compressed)
      : zlib.inflateRawSync(compressed, { maxOutputLength: expandedSize + 1 });
    if (bytes.length !== expandedSize || entries.has(name)) importFailure("归档条目大小或名称冲突");
    entries.set(name, bytes);
    cursor = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function parsePortableManifest(entries: Map<string, Buffer>): {
  manifest: PortableManifest;
  document: CanvasDocument;
} {
  const manifestBytes = entries.get("manifest.json");
  const documentBytes = entries.get("document.json");
  if (!manifestBytes || !documentBytes) importFailure("归档缺少 manifest.json 或 document.json");
  let manifest: PortableManifest;
  let document: CanvasDocument;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8")) as PortableManifest;
    document = JSON.parse(documentBytes.toString("utf8")) as CanvasDocument;
  } catch {
    importFailure("归档 JSON 无效");
  }
  if (
    manifest.formatVersion !== CANVAS_PORTABLE_FORMAT_VERSION
    || manifest.importerSchemaVersion !== CANVAS_IMPORTER_SCHEMA_VERSION
    || manifest.documentEntryName !== "document.json"
    || manifest.documentSha256 !== crypto.createHash("sha256").update(documentBytes).digest("hex")
    || !Array.isArray(manifest.assets)
  ) {
    importFailure("归档清单版本或文档摘要无效");
  }
  const expectedNames = new Set(["document.json", "manifest.json"]);
  for (const asset of manifest.assets) {
    const bytes = entries.get(String(asset.entryName));
    if (
      !/^[0-9a-f-]{36}$/i.test(String(asset.sourceAssetUuid))
      || !/^assets\/sha256\/[0-9a-f]{64}$/.test(String(asset.entryName))
      || !bytes
      || bytes.length !== Number(asset.sizeBytes)
      || crypto.createHash("sha256").update(bytes).digest("hex") !== String(asset.sha256)
    ) {
      importFailure("归档素材清单与实际字节不一致");
    }
    expectedNames.add(asset.entryName);
  }
  if ([...entries.keys()].some((name) => !expectedNames.has(name))) importFailure("归档包含未声明条目");
  return { manifest, document };
}

function replaceImportedAssetUuids(value: unknown, mapping: Map<string, string>): unknown {
  if (typeof value === "string") return mapping.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => replaceImportedAssetUuids(item, mapping));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = replaceImportedAssetUuids(item, mapping);
  }
  return result;
}

function extensionForMime(mimeType: string): string {
  const safe: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
  };
  const extension = safe[mimeType.toLowerCase()];
  if (!extension) importFailure("归档素材类型不受支持");
  return extension;
}

/** 消费已持久化的便携导入任务；可由接收端、启动恢复或测试显式调用。 */
export async function processCanvasImportJob(projectUuid: string, importUuid: string): Promise<void> {
  await acquireProjectDatabaseLease(projectUuid, "scheduler");
  try {
    await runWithProjectStorage(projectUuid, () => processCanvasImportJobInProject(projectUuid, importUuid));
  } finally {
    await releaseProjectDatabaseLease(projectUuid, "scheduler");
  }
}

/** 项目打开或账号恢复后重新调度未完成导入；单任务内部仍由 mutation gate 串行化。 */
export async function resumeCanvasImportJobs(projectUuid: string): Promise<number> {
  await acquireProjectDatabaseLease(projectUuid, "scheduler");
  let importUuids: string[] = [];
  try {
    importUuids = await runWithProjectStorage(projectUuid, async () => {
      const rows = await db("canvas_import_jobs")
        .whereIn("state", ["queued", "validating", "staged", "applying"])
        .select("import_uuid");
      return rows.map((row) => String(row.import_uuid));
    });
  } finally {
    await releaseProjectDatabaseLease(projectUuid, "scheduler");
  }
  for (const importUuid of importUuids) {
    void processCanvasImportJob(projectUuid, importUuid).catch(() => undefined);
  }
  return importUuids.length;
}

async function processCanvasImportJobInProject(projectUuid: string, importUuid: string): Promise<void> {
  return withProjectMutationGate(projectUuid, async () => {
    const job = await db("canvas_import_jobs").where({ import_uuid: importUuid }).first();
    if (!job || String(job.state) === "committed" || String(job.state) === "aborted") return;
    if (!new Set(["queued", "validating", "staged", "applying"]).has(String(job.state))) {
      throw new CanvasRuntimeError("CANVAS_IMPORT_ACTION_INVALID_STATE", "当前导入状态不允许消费", 409, false);
    }
    const ctx = currentUserStorage();
    if (!ctx?.segment) throw new CanvasRuntimeError("PERMISSION_DENIED", "项目不存在或不可见", 403, false);
    const projectRoot = path.join(getPath(), "runtime-users", ctx.segment, "projects", projectUuid);
    const archivePath = path.resolve(projectRoot, ...String(job.staging_relative_path).split("/"));
    if (!archivePath.startsWith(path.resolve(projectRoot) + path.sep)) importFailure("导入暂存路径越界");
    const installedPaths: string[] = [];
    let stage = "claim";
    try {
      await db("canvas_import_jobs").where({ import_uuid: importUuid }).update({
        state: "validating",
        attempt: Number(job.attempt) + 1,
        updated_at: new Date().toISOString(),
      });
      stage = "read-archive";
      const entries = readPortableZipEntries(fs.readFileSync(archivePath));
      stage = "validate-archive";
      const { manifest, document } = parsePortableManifest(entries);
      const assetMapping = new Map<string, string>();
      const preparedAssets = [] as Array<{
        assetUuid: string;
        relativePath: string;
        mimeType: string;
        bytes: Buffer;
        sha256: string;
      }>;
      for (const asset of manifest.assets) {
        const assetUuid = crypto.randomUUID();
        assetMapping.set(asset.sourceAssetUuid, assetUuid);
        preparedAssets.push({
          assetUuid,
          relativePath: `files/imported/${assetUuid}${extensionForMime(asset.mimeType)}`,
          mimeType: asset.mimeType,
          bytes: entries.get(asset.entryName)!,
          sha256: asset.sha256,
        });
      }
      const remapped = remapImportedDocument(document);
      const mappedDocument = replaceImportedAssetUuids(remapped, assetMapping) as CanvasDocument;
      stage = "mark-applying";
      await db("canvas_import_jobs").where({ import_uuid: importUuid }).update({
        state: "applying",
        total_items: 2 + preparedAssets.length,
        validated_items: 2 + preparedAssets.length,
        staged_manifest_json: JSON.stringify({ expandedBytes: [...entries.values()].reduce((n, value) => n + value.length, 0) }),
        updated_at: new Date().toISOString(),
      });
      stage = "install-assets";
      for (const asset of preparedAssets) {
        const installed = await streamProjectFileFromBuffer({
          dataRoot: getPath(),
          projectUuid,
          userSegment: ctx.segment,
          relativePath: asset.relativePath,
          data: asset.bytes,
          maxBytes: CANVAS_LIMITS.MAX_CANVAS_ARCHIVE_ENTRY_BYTES,
        });
        installedPaths.push(installed.absolutePath);
      }
      stage = "save-document";
      const saved = await saveCanvasDocument(projectUuid, {
        baseRevision: Number(job.base_revision),
        clientMutationId: String(job.client_mutation_id),
        document: mappedDocument,
      }, {
        actor: "canvas-import",
        afterSaveInTransaction: async (trx, envelope) => {
          const now = new Date().toISOString();
          for (const asset of preparedAssets) {
            await trx("canvas_assets").insert({
              asset_uuid: asset.assetUuid,
              kind: asset.mimeType.startsWith("video/") ? "video" : asset.mimeType.startsWith("audio/") ? "audio" : "image",
              relative_path: asset.relativePath,
              mime_type: asset.mimeType,
              size_bytes: asset.bytes.length,
              md5: crypto.createHash("md5").update(asset.bytes).digest("hex"),
              sha256: asset.sha256,
              metadata_json: JSON.stringify({ source: "tjcanvas-import" }),
              lifecycle_state: "ready",
              created_by: "canvas-import",
              created_at: now,
              deleted_at: null,
            });
          }
          const terminal = {
            importUuid,
            projectUuid,
            state: "committed",
            appliedRevision: envelope.revision,
          };
          await trx("canvas_import_jobs").where({ import_uuid: importUuid }).update({
            state: "committed",
            moved_items: 2 + preparedAssets.length,
            applied_revision: envelope.revision,
            terminal_response_json: JSON.stringify(terminal),
            failure_code: null,
            updated_at: now,
          });
        },
      });
      void saved;
      stage = "cleanup";
      fs.rmSync(archivePath, { force: true });
      await releaseCanvasImportStaging(String(job.client_mutation_id));
    } catch (error) {
      for (const installedPath of installedPaths) fs.rmSync(installedPath, { force: true });
      await db("canvas_import_jobs").where({ import_uuid: importUuid }).update({
        state: "failed",
        failure_code: String((error as { errorCode?: unknown }).errorCode ?? "CANVAS_IMPORT_FAILED"),
        updated_at: new Date().toISOString(),
      }).catch(() => undefined);
      await releaseCanvasImportStaging(String(job.client_mutation_id)).catch(() => undefined);
      const detail = error instanceof Error ? error.message : JSON.stringify(error);
      throw new Error(`便携导入在 ${stage} 阶段失败：${detail}`, { cause: error });
    }
  });
}

export async function readCanvasImportAcceptance(projectUuid: string, clientMutationId: string) {
  const row = await db("canvas_import_jobs").where({
    client_mutation_id: clientMutationId,
  }).first();
  if (!row) {
    throw new CanvasRuntimeError("CANVAS_IMPORT_NOT_FOUND", "导入任务不存在或不可见", 404, false);
  }
  return JSON.parse(String(row.acceptance_response_json));
}

export async function readCanvasImportStatus(importUuid: string) {
  const row = await db("canvas_import_jobs").where({ import_uuid: importUuid }).first();
  if (!row) {
    throw new CanvasRuntimeError("CANVAS_IMPORT_NOT_FOUND", "导入任务不存在或不可见", 404, false);
  }
  return {
    importUuid: String(row.import_uuid),
    projectUuid: currentUserStorage()?.projectUuid,
    clientMutationId: String(row.client_mutation_id),
    requestDigest: String(row.request_digest),
    state: String(row.state),
    acceptedAt: row.accepted_at,
    receivedBytes: Number(row.archive_size_bytes),
    expandedBytes: row.staged_manifest_json
      ? Number((JSON.parse(String(row.staged_manifest_json)) as { expandedBytes?: number }).expandedBytes ?? 0)
      : 0,
    totalItems: Number(row.total_items),
    validatedItems: Number(row.validated_items),
    movedItems: Number(row.moved_items),
    attempt: Number(row.attempt),
    appliedRevision: row.applied_revision,
    terminalResponse: row.terminal_response_json ? JSON.parse(String(row.terminal_response_json)) : null,
    failureCode: row.failure_code,
    userAction: String(row.state) === "queued" ? "cancel" : "none",
    updatedAt: String(row.updated_at),
  };
}

export async function listActiveCanvasImports() {
  const rows = await db("canvas_import_jobs").whereNotIn("state", [
    "committed",
    "aborted",
    "failed",
  ]);
  return Promise.all(rows.map((row) => readCanvasImportStatus(String(row.import_uuid))));
}

export async function cancelCanvasImport(
  projectUuid: string,
  importUuid: string,
  input: { clientActionId: string; requestDigest: string },
) {
  const expected = sha256Text(canonicalizeJcs({
    operation: "cancel",
    importUuid,
    clientActionId: input.clientActionId,
  }));
  if (expected !== input.requestDigest) {
    throw new CanvasRuntimeError(
      "CANVAS_MUTATION_IDEMPOTENCY_CONFLICT",
      "相同文档变更 ID 的摘要与首次请求不一致",
      409,
      false,
    );
  }
  const existingReceipt = await db("canvas_import_action_receipts").where({
    import_uuid: importUuid,
    action_type: "cancel",
    client_action_id: input.clientActionId,
  }).first();
  if (existingReceipt) {
    if (String(existingReceipt.request_digest) !== input.requestDigest) {
      throw new CanvasRuntimeError(
        "CANVAS_MUTATION_IDEMPOTENCY_CONFLICT",
        "相同文档变更 ID 的摘要与首次请求不一致",
        409,
        false,
      );
    }
    return JSON.parse(String(existingReceipt.response_json));
  }
  const job = await db("canvas_import_jobs").where({ import_uuid: importUuid }).first();
  if (!job) {
    throw new CanvasRuntimeError("CANVAS_IMPORT_NOT_FOUND", "导入任务不存在或不可见", 404, false);
  }
  const cancelable = new Set(["receiving", "awaiting_reupload", "queued", "validating", "staged", "applying"]);
  if (!cancelable.has(String(job.state))) {
    throw new CanvasRuntimeError("CANVAS_IMPORT_ACTION_INVALID_STATE", "当前导入状态不允许该操作", 409, false);
  }
  const now = new Date().toISOString();
  const response = {
    importUuid,
    actionType: "cancel",
    clientActionId: input.clientActionId,
    requestDigest: input.requestDigest,
    state: "aborted",
    createdAt: now,
  };
  await db.transaction(async (trx) => {
    await trx("canvas_import_jobs").where({ import_uuid: importUuid }).update({
      state: "aborted",
      updated_at: now,
    });
    await trx("canvas_import_action_receipts").insert({
      import_uuid: importUuid,
      action_type: "cancel",
      client_action_id: input.clientActionId,
      request_digest: input.requestDigest,
      response_json: JSON.stringify(response),
      audit_uuid: crypto.randomUUID(),
      created_at: now,
    });
    await upsertPendingMutationJournalInTrx(trx, "canvas:import-cancel");
  });
  const ctx = currentUserStorage();
  if (ctx?.segment) {
    const staging = path.join(
      getPath(),
      "runtime-users",
      ctx.segment,
      "projects",
      projectUuid,
      ...String(job.staging_relative_path).split("/"),
    );
    fs.rmSync(staging, { force: true });
  }
  return response;
}

export async function reconcileCanvasImport(
  importUuid: string,
  input: { clientActionId: string; requestDigest: string },
) {
  const job = await db("canvas_import_jobs").where({ import_uuid: importUuid }).first();
  if (!job) {
    throw new CanvasRuntimeError("CANVAS_IMPORT_NOT_FOUND", "导入任务不存在或不可见", 404, false);
  }
  if (String(job.state) !== "recovery_required") {
    throw new CanvasRuntimeError("CANVAS_IMPORT_ACTION_INVALID_STATE", "当前导入状态不允许该操作", 409, false);
  }
  return { importUuid, state: String(job.state) };
}

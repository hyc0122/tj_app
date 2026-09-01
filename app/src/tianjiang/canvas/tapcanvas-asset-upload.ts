import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";

import { db } from "@/utils/db";
import getPath from "@/utils/getPath";
import { CANVAS_LIMITS } from "../contracts";
import { projectDirectory } from "../data/paths";
import { streamProjectFile } from "../media/stream-project-file";
import { upsertPendingMutationJournalInTrx } from "../runtime/legacy-mutation-journal";
import { withProjectMutationGate } from "../runtime/project-mutation-gate";
import { currentUserStorage } from "../runtime/user-storage-context";

export type TapCanvasAssetKind = "image" | "video" | "audio" | "document";

export interface TapCanvasAssetType {
  mimeType: string;
  kind: TapCanvasAssetKind;
  extension: string;
  directory: "images" | "videos" | "audio" | "documents";
}

export interface TapCanvasUploadedAssetDto {
  id: string;
  name: string;
  data: {
    url: string;
    kind: "upload";
    assetKind: TapCanvasAssetKind;
    mimeType: string;
    contentType: string;
    originalName: string;
    size: number;
    sizeBytes: number;
    sha256: string;
    md5: string;
    lifecycleState: "ready";
  };
  createdAt: string;
  updatedAt: string;
  userId: string;
  projectId: string;
}

class TapCanvasAssetUploadError extends Error {
  status: number;
  errorCode: string;

  constructor(message: string, status = 415, errorCode = "TAPCANVAS_ASSET_TYPE_UNSUPPORTED") {
    super(message);
    this.name = "TapCanvasAssetUploadError";
    this.status = status;
    this.errorCode = errorCode;
  }
}

const signature = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff]),
  gif87: Buffer.from("GIF87a", "ascii"),
  gif89: Buffer.from("GIF89a", "ascii"),
  webm: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  pdf: Buffer.from("%PDF-", "ascii"),
  zip: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  ogg: Buffer.from("OggS", "ascii"),
  id3: Buffer.from("ID3", "ascii"),
} as const;

function startsWith(head: Buffer, expected: Buffer): boolean {
  return head.length >= expected.length && head.subarray(0, expected.length).equals(expected);
}

function normalizedMime(raw: string): string {
  return raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function safeExtension(fileName: string): string {
  const extension = path.extname(fileName).slice(1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(extension) ? extension : "";
}

function unsupported(): never {
  throw new TapCanvasAssetUploadError("不支持该素材格式或文件内容与声明类型不一致");
}

/**
 * 中文注释：声明类型只用于缩小判断范围，最终必须通过文件头校验，防止把 HTML/可执行文件伪装成素材。
 */
export function resolveTapCanvasAssetType(
  declaredMime: string,
  originalName: string,
  head: Buffer,
): TapCanvasAssetType {
  const mime = normalizedMime(declaredMime);
  const extension = safeExtension(originalName);
  const textHead = head.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (!head.length || textHead.startsWith("<html") || textHead.startsWith("<!doctype html") || textHead.startsWith("<svg")) {
    return unsupported();
  }
  if (startsWith(head, signature.png) && (!mime || mime === "image/png" || mime === "application/octet-stream")) {
    return { mimeType: "image/png", kind: "image", extension: "png", directory: "images" };
  }
  if (startsWith(head, signature.jpeg) && (!mime || ["image/jpeg", "image/jpg", "application/octet-stream"].includes(mime))) {
    return { mimeType: "image/jpeg", kind: "image", extension: "jpg", directory: "images" };
  }
  if ((startsWith(head, signature.gif87) || startsWith(head, signature.gif89)) && (!mime || ["image/gif", "application/octet-stream"].includes(mime))) {
    return { mimeType: "image/gif", kind: "image", extension: "gif", directory: "images" };
  }
  if (head.length >= 12 && head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP") {
    if (mime && !["image/webp", "application/octet-stream"].includes(mime)) return unsupported();
    return { mimeType: "image/webp", kind: "image", extension: "webp", directory: "images" };
  }
  if (head.length >= 8 && head.subarray(4, 8).toString("ascii") === "ftyp") {
    const audio = mime === "audio/mp4" || extension === "m4a";
    if (mime && !["video/mp4", "video/quicktime", "audio/mp4", "application/octet-stream"].includes(mime)) return unsupported();
    return audio
      ? { mimeType: "audio/mp4", kind: "audio", extension: "m4a", directory: "audio" }
      : { mimeType: mime === "video/quicktime" ? "video/quicktime" : "video/mp4", kind: "video", extension: mime === "video/quicktime" || extension === "mov" ? "mov" : "mp4", directory: "videos" };
  }
  if (startsWith(head, signature.webm) && (!mime || ["video/webm", "application/octet-stream"].includes(mime))) {
    return { mimeType: "video/webm", kind: "video", extension: "webm", directory: "videos" };
  }
  if (head.length >= 12 && head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WAVE") {
    if (mime && !["audio/wav", "audio/x-wav", "application/octet-stream"].includes(mime)) return unsupported();
    return { mimeType: "audio/wav", kind: "audio", extension: "wav", directory: "audio" };
  }
  if (startsWith(head, signature.ogg) && (!mime || ["audio/ogg", "application/ogg", "application/octet-stream"].includes(mime))) {
    return { mimeType: "audio/ogg", kind: "audio", extension: "ogg", directory: "audio" };
  }
  const mp3Frame = head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0;
  if ((startsWith(head, signature.id3) || mp3Frame) && (!mime || ["audio/mpeg", "audio/mp3", "application/octet-stream"].includes(mime))) {
    return { mimeType: "audio/mpeg", kind: "audio", extension: "mp3", directory: "audio" };
  }
  if (startsWith(head, signature.pdf) && (!mime || ["application/pdf", "application/octet-stream"].includes(mime))) {
    return { mimeType: "application/pdf", kind: "document", extension: "pdf", directory: "documents" };
  }
  if (startsWith(head, signature.zip) && (!mime || ["application/zip", "application/x-zip-compressed", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/octet-stream"].includes(mime))) {
    const docx = extension === "docx" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    return {
      mimeType: docx ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/zip",
      kind: "document",
      extension: docx ? "docx" : "zip",
      directory: "documents",
    };
  }
  const textMimes = new Set(["text/plain", "text/markdown", "application/json"]);
  if (textMimes.has(mime) && !head.includes(0)) {
    const outputExtension = mime === "application/json" ? "json" : mime === "text/markdown" || extension === "md" ? "md" : "txt";
    return { mimeType: mime, kind: "document", extension: outputExtension, directory: "documents" };
  }
  return unsupported();
}

function uploadIdentity(): { dataRoot: string; projectUuid: string; userSegment: string } {
  const context = currentUserStorage();
  if (!context?.projectUuid || !context.segment) {
    throw new TapCanvasAssetUploadError("项目不存在或不可见", 403, "PERMISSION_DENIED");
  }
  return { dataRoot: getPath(), projectUuid: context.projectUuid, userSegment: context.segment };
}

function sanitizeName(raw: string): string {
  const name = raw.trim().slice(0, 240).replace(/[\u0000-\u001f\u007f\\/]/g, "_");
  return name || "未命名素材";
}

async function prepareValidatedStream(req: IncomingMessage): Promise<{ head: Buffer; chunks: AsyncIterable<Buffer> }> {
  const iterator = req[Symbol.asyncIterator]();
  const buffered: Buffer[] = [];
  let headBytes = 0;
  while (headBytes < 512) {
    const next = await iterator.next();
    if (next.done) break;
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    if (!chunk.length) continue;
    buffered.push(chunk);
    headBytes += chunk.length;
  }
  const head = Buffer.concat(buffered).subarray(0, 512);
  async function* chunks(): AsyncGenerator<Buffer> {
    for (const chunk of buffered) yield chunk;
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      if (chunk.length) yield chunk;
    }
  }
  return { head, chunks: chunks() };
}

function assetUrl(projectUuid: string, relativePath: string): string {
  const suffix = relativePath.replace(/^files\//, "").split("/").map(encodeURIComponent).join("/");
  return `/api/tianjiang/runtime/projects/${encodeURIComponent(projectUuid)}/files/${suffix}`;
}

/** 中文注释：以流式方式写入当前项目，落库成功后才向同步协调器声明变更。 */
export async function uploadTapCanvasAsset(
  req: IncomingMessage,
  projectUuid: string,
  input: {
    declaredMime: string;
    originalName: string;
    userId: string;
    ownerNodeId?: string;
  },
): Promise<TapCanvasUploadedAssetDto> {
  const declaredBytes = Number(req.headers["content-length"] ?? req.headers["x-file-size"] ?? 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > CANVAS_LIMITS.MAX_CANVAS_MULTIPART_FILE_BYTES) {
    throw new TapCanvasAssetUploadError("素材超过画布允许的大小", 413, "CANVAS_BODY_TOO_LARGE");
  }
  const prepared = await prepareValidatedStream(req);
  const originalName = sanitizeName(input.originalName);
  const assetType = resolveTapCanvasAssetType(input.declaredMime, originalName, prepared.head);
  const assetUuid = crypto.randomUUID();
  const relativePath = `files/${assetType.directory}/${assetUuid}.${assetType.extension}`;
  const stagingRelativePath = `.staging/tapcanvas-assets/${assetUuid}.${assetType.extension}`;
  const identity = uploadIdentity();
  if (identity.projectUuid !== projectUuid) {
    throw new TapCanvasAssetUploadError("项目不存在或不可见", 403, "PERMISSION_DENIED");
  }

  return withProjectMutationGate(projectUuid, async () => {
    let stagedAbsolutePath = "";
    let finalAbsolutePath = "";
    try {
      const projectRoot = projectDirectory(identity.dataRoot, projectUuid, identity.userSegment);
      // 中文注释：先记录预期路径，确保流式写入中途超限或断线时也能删除半文件。
      stagedAbsolutePath = path.resolve(projectRoot, ...stagingRelativePath.split("/"));
      const staged = await streamProjectFile({
        dataRoot: identity.dataRoot,
        projectUuid,
        userSegment: identity.userSegment,
        relativePath: stagingRelativePath,
        chunks: prepared.chunks,
        maxBytes: CANVAS_LIMITS.MAX_CANVAS_MULTIPART_FILE_BYTES,
      });
      if (!staged.size) {
        throw new TapCanvasAssetUploadError("素材文件为空", 422, "TAPCANVAS_ASSET_EMPTY");
      }
      stagedAbsolutePath = staged.absolutePath;
      finalAbsolutePath = path.resolve(projectRoot, ...relativePath.split("/"));
      fs.mkdirSync(path.dirname(finalAbsolutePath), { recursive: true });
      fs.renameSync(stagedAbsolutePath, finalAbsolutePath);
      stagedAbsolutePath = "";

      const now = new Date().toISOString();
      const metadata = {
        originalName,
        ownerNodeId: input.ownerNodeId?.trim() || null,
        source: "tapcanvas",
      };
      await db.transaction(async (trx) => {
        await trx("canvas_assets").insert({
          asset_uuid: assetUuid,
          kind: assetType.kind,
          relative_path: relativePath,
          mime_type: assetType.mimeType,
          size_bytes: staged.size,
          md5: staged.md5,
          sha256: staged.sha256,
          metadata_json: JSON.stringify(metadata),
          lifecycle_state: "ready",
          created_by: input.userId || "canvas-owner",
          created_at: now,
          deleted_at: null,
        });
        await upsertPendingMutationJournalInTrx(trx, "canvas:tapcanvas-asset-upload");
      });
      try {
        const { syncCoordinator } = await import("../runtime/runtime");
        syncCoordinator.markLegacyMutation(projectUuid);
      } catch {
        // 中文注释：业务和 journal 已提交，协调器恢复时会补做同步。
      }
      return {
        id: assetUuid,
        name: originalName,
        data: {
          url: assetUrl(projectUuid, relativePath),
          kind: "upload",
          assetKind: assetType.kind,
          mimeType: assetType.mimeType,
          contentType: assetType.mimeType,
          originalName,
          size: staged.size,
          sizeBytes: staged.size,
          sha256: staged.sha256,
          md5: staged.md5,
          lifecycleState: "ready",
        },
        createdAt: now,
        updatedAt: now,
        userId: input.userId,
        projectId: projectUuid,
      };
    } catch (error) {
      if (stagedAbsolutePath) fs.rmSync(stagedAbsolutePath, { force: true });
      if (finalAbsolutePath) fs.rmSync(finalAbsolutePath, { force: true });
      throw error;
    }
  });
}

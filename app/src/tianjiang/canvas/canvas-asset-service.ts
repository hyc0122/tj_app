import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";

import { db } from "@/utils/db";
import getPath from "@/utils/getPath";
import { parseRestrictedMultipart } from "../media/restricted-multipart";
import { streamProjectFileFromBuffer } from "../media/stream-project-file";
import { upsertPendingMutationJournalInTrx } from "../runtime/legacy-mutation-journal";
import { withProjectMutationGate } from "../runtime/project-mutation-gate";
import { currentUserStorage } from "../runtime/user-storage-context";
import { CANVAS_LIMITS } from "../contracts";
import { CanvasRuntimeError, sha256Text } from "./canvas-document-service";
import { canonicalizeJcs } from "./canvas-import-export-service";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

export function assetUploadDigest(projectUuid: string, file: Buffer, mimeType: string): string {
  return sha256Text(canonicalizeJcs({
    operation: "asset-upload",
    projectUuid,
    sha256: crypto.createHash("sha256").update(file).digest("hex"),
    sizeBytes: file.length,
    mimeType,
  }));
}

export function assetDeleteDigest(projectUuid: string, assetUuid: string, expectedSha256: string): string {
  return sha256Text(canonicalizeJcs({
    operation: "asset-delete",
    projectUuid,
    assetUuid,
    expectedSha256,
  }));
}

function identity(): { dataRoot: string; projectUuid: string; userSegment: string } {
  const context = currentUserStorage();
  if (!context?.projectUuid || !context.segment) {
    throw new CanvasRuntimeError("PERMISSION_DENIED", "项目不存在或不可见", 403, false);
  }
  return { dataRoot: getPath(), projectUuid: context.projectUuid, userSegment: context.segment };
}

function detectPng(file: Buffer, declared: string): string {
  if (file.subarray(0, 4).equals(PNG_MAGIC) && (declared === "image/png" || declared === "")) {
    return "image/png";
  }
  const head = file.subarray(0, 256).toString("utf8").toLowerCase();
  if (head.includes("<svg") || head.includes("<html") || declared.includes("svg") || declared.includes("html")) {
    throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "便携画布导入请求不合法", 422, false);
  }
  throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "便携画布导入请求不合法", 422, false);
}

export async function listCanvasAssets(): Promise<Array<{
  assetUuid: string;
  relativePath: string;
  lifecycleState: string;
  sha256: string;
  md5: string;
}>> {
  const rows = await db("canvas_assets").select(
    "asset_uuid",
    "relative_path",
    "lifecycle_state",
    "sha256",
    "md5",
  );
  return rows.map((row) => ({
    assetUuid: String(row.asset_uuid),
    relativePath: String(row.relative_path),
    lifecycleState: String(row.lifecycle_state),
    sha256: String(row.sha256),
    md5: String(row.md5),
  }));
}

export async function uploadCanvasAsset(req: IncomingMessage, projectUuid: string): Promise<{
  assetUuid: string;
  relativePath: string;
  sha256: string;
  md5: string;
  sizeBytes: number;
}> {
  const parsed = await parseRestrictedMultipart(req, {
    maxFileBytes: CANVAS_LIMITS.MAX_CANVAS_MULTIPART_FILE_BYTES,
    maxFiles: 1,
    maxTotalBytes: CANVAS_LIMITS.MAX_CANVAS_MULTIPART_TOTAL_BYTES,
  });
  const mutationId = String(parsed.fields.clientAssetMutationId ?? "");
  const requestDigest = String(parsed.fields.requestDigest ?? "");
  const file = parsed.files[0];
  if (!file?.buffer?.length || !/^[0-9a-f-]{36}$/i.test(mutationId)) {
    throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "便携画布导入请求不合法", 422, false);
  }
  const mimeType = detectPng(file.buffer, file.mime);
  const expected = assetUploadDigest(projectUuid, file.buffer, mimeType);
  if (expected !== requestDigest) {
    throw new CanvasRuntimeError(
      "CANVAS_ASSET_MUTATION_IDEMPOTENCY_CONFLICT",
      "相同素材变更 ID 的摘要与首次请求不一致",
      409,
      false,
    );
  }
  return withProjectMutationGate(projectUuid, async () => {
    const existing = await db("canvas_asset_mutations").where({
      client_asset_mutation_id: mutationId,
    }).first();
    if (existing) {
      if (String(existing.request_digest) !== requestDigest) {
        throw new CanvasRuntimeError(
          "CANVAS_ASSET_MUTATION_IDEMPOTENCY_CONFLICT",
          "相同素材变更 ID 的摘要与首次请求不一致",
          409,
          false,
        );
      }
      return JSON.parse(String(existing.response_json));
    }
    const assetUuid = crypto.randomUUID();
    const relativePath = `files/images/${assetUuid}.png`;
    const ctx = identity();
    const stagedRelative = `.staging/canvas-assets/${assetUuid}.png`;
    const staged = await streamProjectFileFromBuffer({
      dataRoot: ctx.dataRoot,
      projectUuid,
      userSegment: ctx.userSegment,
      relativePath: stagedRelative,
      data: file.buffer,
      maxBytes: CANVAS_LIMITS.MAX_CANVAS_MULTIPART_FILE_BYTES,
    });
    const finalPath = path.join(ctx.dataRoot, "runtime-users", ctx.userSegment, "projects", projectUuid, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.renameSync(staged.absolutePath, finalPath);
    const now = new Date().toISOString();
    const response = {
      assetUuid,
      relativePath,
      sha256: staged.sha256,
      md5: staged.md5,
      sizeBytes: staged.size,
    };
    await db.transaction(async (trx) => {
      await trx("canvas_assets").insert({
        asset_uuid: assetUuid,
        kind: "image",
        relative_path: relativePath,
        mime_type: mimeType,
        size_bytes: staged.size,
        md5: staged.md5,
        sha256: staged.sha256,
        metadata_json: null,
        lifecycle_state: "ready",
        created_by: "canvas-owner",
        created_at: now,
        deleted_at: null,
      });
      await trx("canvas_asset_mutations").insert({
        client_asset_mutation_id: mutationId,
        operation: "upload",
        request_digest: requestDigest,
        asset_uuid: assetUuid,
        response_json: JSON.stringify(response),
        state: "committed",
        created_at: now,
        updated_at: now,
      });
      await upsertPendingMutationJournalInTrx(trx, "canvas:asset-upload");
    });
    try {
      const { syncCoordinator } = await import("../runtime/runtime");
      syncCoordinator.markLegacyMutation(projectUuid);
    } catch {
      // 中文注释：业务已提交，markEdited 失败由 journal 恢复。
    }
    return response;
  });
}

export async function registerCanvasResultAsset(projectUuid: string, file: Buffer, mimeType: string): Promise<{
  assetUuid: string;
  relativePath: string;
  sha256: string;
  md5: string;
}> {
  const ctx = identity();
  const assetUuid = crypto.randomUUID();
  const relativePath = `files/images/${assetUuid}.png`;
  const staged = await streamProjectFileFromBuffer({
    dataRoot: ctx.dataRoot,
    projectUuid,
    userSegment: ctx.userSegment,
    relativePath: `.staging/canvas-assets/${assetUuid}.png`,
    data: file,
    maxBytes: CANVAS_LIMITS.MAX_CANVAS_MULTIPART_FILE_BYTES,
  });
  const finalPath = path.join(ctx.dataRoot, "runtime-users", ctx.userSegment, "projects", projectUuid, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  fs.renameSync(staged.absolutePath, finalPath);
  const now = new Date().toISOString();
  await db("canvas_assets").insert({
    asset_uuid: assetUuid,
    kind: "image",
    relative_path: relativePath,
    mime_type: mimeType || "image/png",
    size_bytes: staged.size,
    md5: staged.md5,
    sha256: staged.sha256,
    metadata_json: null,
    lifecycle_state: "ready",
    created_by: "canvas-owner",
    created_at: now,
    deleted_at: null,
  });
  return { assetUuid, relativePath, sha256: staged.sha256, md5: staged.md5 };
}

export async function deleteCanvasAsset(
  projectUuid: string,
  assetUuid: string,
  input: { clientAssetMutationId: string; requestDigest: string; expectedSha256: string },
): Promise<{ assetUuid: string; deleted: true }> {
  const expected = assetDeleteDigest(projectUuid, assetUuid, input.expectedSha256);
  if (expected !== input.requestDigest) {
    throw new CanvasRuntimeError(
      "CANVAS_ASSET_MUTATION_IDEMPOTENCY_CONFLICT",
      "相同素材变更 ID 的摘要与首次请求不一致",
      409,
      false,
    );
  }
  return withProjectMutationGate(projectUuid, async () => {
    const existing = await db("canvas_asset_mutations").where({
      client_asset_mutation_id: input.clientAssetMutationId,
    }).first();
    if (existing) {
      if (String(existing.request_digest) !== input.requestDigest) {
        throw new CanvasRuntimeError(
          "CANVAS_ASSET_MUTATION_IDEMPOTENCY_CONFLICT",
          "相同素材变更 ID 的摘要与首次请求不一致",
          409,
          false,
        );
      }
      return JSON.parse(String(existing.response_json));
    }
    const asset = await db("canvas_assets").where({ asset_uuid: assetUuid }).first();
    if (!asset || String(asset.sha256) !== input.expectedSha256) {
      throw new CanvasRuntimeError("PERMISSION_DENIED", "项目不存在或不可见", 403, false);
    }
    const now = new Date().toISOString();
    const response = { assetUuid, deleted: true as const };
    await db.transaction(async (trx) => {
      await trx("canvas_assets").where({ asset_uuid: assetUuid }).update({
        lifecycle_state: "deleting",
        deleted_at: now,
      });
      await trx("canvas_asset_mutations").insert({
        client_asset_mutation_id: input.clientAssetMutationId,
        operation: "delete",
        request_digest: input.requestDigest,
        asset_uuid: assetUuid,
        response_json: JSON.stringify(response),
        state: "committed",
        created_at: now,
        updated_at: now,
      });
      await upsertPendingMutationJournalInTrx(trx, "canvas:asset-delete");
    });
    const ctx = identity();
    const absolute = path.join(
      ctx.dataRoot,
      "runtime-users",
      ctx.userSegment,
      "projects",
      projectUuid,
      ...String(asset.relative_path).split("/"),
    );
    try {
      fs.rmSync(absolute, { force: true });
    } catch {
      // 中文注释：文件缺失时仍保留 tombstone，供 GC 重试。
    }
    try {
      const { syncCoordinator } = await import("../runtime/runtime");
      syncCoordinator.markLegacyMutation(projectUuid);
    } catch {
      // 中文注释：业务已提交，markEdited 失败由 journal 恢复。
    }
    return response;
  });
}

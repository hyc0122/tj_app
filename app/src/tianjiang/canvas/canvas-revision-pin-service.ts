import { db } from "@/utils/db";
import { upsertPendingMutationJournalInTrx } from "../runtime/legacy-mutation-journal";
import { RuntimePermissionError } from "../runtime/sync-coordinator";
import { CanvasRuntimeError, sha256Text } from "./canvas-document-service";

export function pinRequestDigest(projectUuid: string, revisionUuid: string, pinReason: string): string {
  return sha256Text(JSON.stringify({
    operation: "pin",
    projectUuid,
    revisionUuid,
    pinReason,
  }));
}

export function unpinRequestDigest(projectUuid: string, revisionUuid: string, resolutionNote: string): string {
  return sha256Text(JSON.stringify({
    operation: "unpin",
    projectUuid,
    revisionUuid,
    resolutionNote,
  }));
}

export async function pinCanvasRevision(
  projectUuid: string,
  revisionUuid: string,
  input: { clientMutationId: string; requestDigest: string; pinReason: string },
): Promise<{ revisionUuid: string; pinned: true }> {
  const expected = pinRequestDigest(projectUuid, revisionUuid, String(input.pinReason ?? "").trim());
  if (expected !== input.requestDigest) {
    throw new CanvasRuntimeError("CANVAS_MUTATION_IDEMPOTENCY_CONFLICT", "相同文档变更 ID 的摘要与首次请求不一致", 409, false);
  }
  const result = await db.transaction(async (trx) => {
    const existing = await trx("canvas_revision_pin_mutations").where({
      client_mutation_id: input.clientMutationId,
    }).first();
    if (existing) {
      if (String(existing.request_digest) !== input.requestDigest) {
        throw new CanvasRuntimeError("CANVAS_MUTATION_IDEMPOTENCY_CONFLICT", "相同文档变更 ID 的摘要与首次请求不一致", 409, false);
      }
      return JSON.parse(String(existing.response_json)) as { revisionUuid: string; pinned: true };
    }
    const revision = await trx("canvas_revisions").where({ revision_uuid: revisionUuid }).first();
    if (!revision) throw new RuntimePermissionError("项目不存在或不可见", "PERMISSION_DENIED");
    const now = new Date().toISOString();
    await trx("canvas_revisions").where({ revision_uuid: revisionUuid }).update({
      is_pinned: 1,
      pin_reason: String(input.pinReason ?? "").trim(),
      pinned_at: now,
    });
    const response = { revisionUuid, pinned: true as const };
    await trx("canvas_revision_pin_mutations").insert({
      client_mutation_id: input.clientMutationId,
      revision_uuid: revisionUuid,
      operation: "pin",
      request_digest: input.requestDigest,
      response_json: JSON.stringify(response),
      created_at: now,
    });
    await upsertPendingMutationJournalInTrx(trx, "canvas:revision-pin");
    return response;
  });
  try {
    const { syncCoordinator } = await import("../runtime/runtime");
    syncCoordinator.markLegacyMutation(projectUuid);
  } catch {
    // 中文注释：业务事务已提交，markEdited 失败不得回滚，启动恢复从 journal 唤醒。
  }
  return result;
}

export async function unpinCanvasRevision(
  projectUuid: string,
  revisionUuid: string,
  input: { clientMutationId: string; requestDigest: string; resolutionNote: string },
): Promise<{ revisionUuid: string; pinned: false }> {
  const expected = unpinRequestDigest(projectUuid, revisionUuid, String(input.resolutionNote ?? "").trim());
  if (expected !== input.requestDigest) {
    throw new CanvasRuntimeError("CANVAS_MUTATION_IDEMPOTENCY_CONFLICT", "相同文档变更 ID 的摘要与首次请求不一致", 409, false);
  }
  const result = await db.transaction(async (trx) => {
    const existing = await trx("canvas_revision_pin_mutations").where({
      client_mutation_id: input.clientMutationId,
    }).first();
    if (existing) {
      if (String(existing.request_digest) !== input.requestDigest) {
        throw new CanvasRuntimeError("CANVAS_MUTATION_IDEMPOTENCY_CONFLICT", "相同文档变更 ID 的摘要与首次请求不一致", 409, false);
      }
      return JSON.parse(String(existing.response_json)) as { revisionUuid: string; pinned: false };
    }
    const revision = await trx("canvas_revisions").where({ revision_uuid: revisionUuid }).first();
    if (!revision) throw new RuntimePermissionError("项目不存在或不可见", "PERMISSION_DENIED");
    const now = new Date().toISOString();
    await trx("canvas_revisions").where({ revision_uuid: revisionUuid }).update({
      is_pinned: 0,
      pin_reason: null,
      pinned_at: null,
    });
    const response = { revisionUuid, pinned: false as const };
    await trx("canvas_revision_pin_mutations").insert({
      client_mutation_id: input.clientMutationId,
      revision_uuid: revisionUuid,
      operation: "unpin",
      request_digest: input.requestDigest,
      response_json: JSON.stringify(response),
      created_at: now,
    });
    await upsertPendingMutationJournalInTrx(trx, "canvas:revision-unpin");
    return response;
  });
  try {
    const { syncCoordinator } = await import("../runtime/runtime");
    syncCoordinator.markLegacyMutation(projectUuid);
  } catch {
    // 中文注释：业务事务已提交，markEdited 失败不得回滚，启动恢复从 journal 唤醒。
  }
  return result;
}

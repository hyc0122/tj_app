/**
 * 按 taskClass + relatedObjects 登记幂等产物终结器。
 * 产物文件写入成功后，业务表与 o_tasks 必须在同一事务提交。
 */
import fs from "node:fs";
import path from "node:path";
import type { Knex } from "knex";

import getPath from "@/utils/getPath";
import { currentUserStorage } from "../runtime/user-storage-context";
import { writeProjectFileAtomic } from "../media/project-file-store";
import type { NormalizedGenerationArtifact } from "./generation-task-artifacts";
import {
  parseGenerationCompletionContract,
  type GenerationCompletionContractV1,
} from "./generation-completion-contract";

export interface RecoveredTaskRow {
  id: number;
  taskClass?: string | null;
  relatedObjects?: string | null;
  resultLocator?: string | null;
  projectUuid: string;
  remoteTaskId: string;
  provider: string;
}

export type RelatedGenerationTarget = Partial<GenerationCompletionContractV1> & {
  kind?: string;
  relativePath?: string;
  mediaType?: string;
};

export interface GenerationTaskFinalizer {
  (input: {
    trx: Knex.Transaction;
    filesDatabase: Knex;
    task: RecoveredTaskRow;
    related: RelatedGenerationTarget;
    artifact: NormalizedGenerationArtifact;
    now: number;
  }): Promise<void>;
}

const finalizers = new Map<string, GenerationTaskFinalizer>();

export function registerGenerationTaskFinalizer(
  taskClass: string,
  finalizer: GenerationTaskFinalizer,
): () => void {
  const key = taskClass.trim();
  if (!key) throw new Error("任务分类无效");
  finalizers.set(key, finalizer);
  return () => {
    if (finalizers.get(key) === finalizer) finalizers.delete(key);
  };
}

export function parseRelatedGenerationTarget(raw: string | null | undefined): RelatedGenerationTarget {
  if (!raw) return {};
  try {
    return parseGenerationCompletionContract(raw);
  } catch {
    return {};
  }
}

export async function applyGenerationBusinessFinalizer(input: {
  trx: Knex.Transaction;
  filesDatabase: Knex;
  task: RecoveredTaskRow;
  related: RelatedGenerationTarget;
  artifact: NormalizedGenerationArtifact;
  now: number;
}): Promise<void> {
  const finalizer = resolveGenerationTaskFinalizer(input.task.taskClass, input.related);
  if (!finalizer) throw new Error("缺少任务产物终结器，不能标记为已完成");
  await finalizer(input);
}

export function resolveGenerationTaskFinalizer(
  taskClass: string | null | undefined,
  related: RelatedGenerationTarget,
): GenerationTaskFinalizer | undefined {
  const exact = finalizers.get(String(taskClass ?? "").trim());
  if (exact) return exact;
  if (related.kind === "dreamina" || related.kind === "vendor-storyboard") {
    return finalizers.get("storyboard");
  }
  return undefined;
}

export async function installRecoveredArtifactFile(
  database: Knex,
  projectUuid: string,
  relativePath: string,
  artifact: NormalizedGenerationArtifact,
): Promise<string> {
  const normalized = normalizeRelativePath(relativePath);
  const bytes = readArtifactBytes(artifact);
  const context = currentUserStorage();
  if (context?.projectUuid) {
    writeProjectFileAtomic(getPath(), context.projectUuid, context.segment, normalized, bytes);
    return normalized;
  }
  const sqlitePath = knexFilename(database);
  if (!sqlitePath) throw new Error("无法解析项目数据库路径");
  const dest = path.join(path.dirname(sqlitePath), ...normalized.split("/"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
  return normalized;
}

function readArtifactBytes(artifact: NormalizedGenerationArtifact): Buffer {
  if (artifact.sourceKind !== "local_path" || !artifact.localPath) {
    throw new Error("恢复终结器当前只接受本地产物文件");
  }
  if (!fs.existsSync(artifact.localPath)) throw new Error("产物文件缺失");
  const bytes = fs.readFileSync(artifact.localPath);
  if (bytes.length <= 0) throw new Error("产物文件为空");
  return bytes;
}

function normalizeRelativePath(relativePath: string): string {
  const trimmed = relativePath.replace(/^\/+/, "").replace(/\\/g, "/");
  if (!trimmed || trimmed.split("/").some((part) => part === "." || part === ".." || part === "")) {
    throw new Error("产物相对路径无效");
  }
  return trimmed;
}

function knexFilename(database: Knex): string | undefined {
  const connection = (database.client as { config?: { connection?: { filename?: string } } })
    ?.config?.connection;
  return connection?.filename;
}

const finalizeVideo: GenerationTaskFinalizer = async ({ trx, related }) => {
  if (!related.videoId || !related.relativePath) throw new Error("视频任务缺少 relatedObjects.videoId");
  const updated = await trx("o_video").where("id", related.videoId).update({
    filePath: related.relativePath,
    state: "生成成功",
    errorReason: null,
  });
  if (!updated) throw new Error("视频业务行不存在");
};

const finalizeImage: GenerationTaskFinalizer = async ({ trx, related }) => {
  if (!related.imageId || !related.relativePath) throw new Error("图片任务缺少 relatedObjects.imageId");
  const patch: Record<string, unknown> = {
    filePath: related.relativePath,
    state: "已完成",
    errorReason: null,
  };
  if (related.assetsId) patch.assetsId = related.assetsId;
  const updated = await trx("o_image").where("id", related.imageId).update(patch);
  if (!updated) throw new Error("图片业务行不存在");
};

const finalizeStoryboardImage: GenerationTaskFinalizer = async ({ trx, related }) => {
  if (!related.storyboardId || !related.relativePath) throw new Error("分镜图片任务缺少 relatedObjects.storyboardId");
  const updated = await trx("o_storyboard").where("id", related.storyboardId).update({
    filePath: related.relativePath,
    state: "已完成",
    reason: null,
  });
  if (!updated) throw new Error("分镜业务行不存在");
};

const finalizeStoryboardVendor: GenerationTaskFinalizer = async ({ trx, related, task }) => {
  if (!related.taskUuid || !related.shotUuid || !related.relativePath) {
    throw new Error("分镜耐久任务缺少 taskUuid/shotUuid");
  }
  const mediaType = related.mediaType === "video" ? "video" : "image";
  const { installStoryboardCandidate } = await import(
    "@/tianjiang/storyboard/storyboard-generation-service"
  );
  await installStoryboardCandidate({
    projectUuid: task.projectUuid,
    shotUuid: related.shotUuid,
    mediaType,
    relativePath: related.relativePath,
    select: true,
    candidateUuid: related.taskUuid,
    trx,
  });
  const { completeVendorGenerationTaskInTrx } = await import(
    "@/tianjiang/storyboard/vendor-generation-scheduler"
  );
  await completeVendorGenerationTaskInTrx(trx, related.taskUuid);
};

const finalizeCanvasGeneration: GenerationTaskFinalizer = async ({ trx, related, artifact, now }) => {
  if (!related.canvasRunUuid || !related.canvasNodeUuid || !related.relativePath || !related.mediaType) {
    throw new Error("画布生成任务缺少完成合同字段");
  }
  const bytes = readArtifactBytes(artifact);
  const crypto = await import("node:crypto");
  const assetUuid = related.canvasRunUuid;
  const mimeType = artifact.contentType || (related.mediaType === "video" ? "video/mp4" : "image/png");
  await trx("canvas_assets").insert({
    asset_uuid: assetUuid,
    kind: related.mediaType,
    relative_path: related.relativePath,
    mime_type: mimeType,
    size_bytes: bytes.length,
    md5: crypto.createHash("md5").update(bytes).digest("hex"),
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    metadata_json: JSON.stringify({ source: "canvas-generation", runUuid: related.canvasRunUuid }),
    lifecycle_state: "ready",
    created_by: "canvas-owner",
    created_at: new Date(now).toISOString(),
    deleted_at: null,
  }).onConflict("asset_uuid").ignore();
  const document = await trx("canvas_documents").where({ id: 1 }).first();
  if (!document) throw new Error("画布文档不存在");
  const graph = JSON.parse(String(document.graph_json)) as {
    nodes?: Array<{ nodeUuid?: string; data?: Record<string, unknown> }>;
    edges?: unknown[];
  };
  const node = graph.nodes?.find((item) => item.nodeUuid === related.canvasNodeUuid);
  if (!node) throw new Error("画布生成节点不存在");
  node.data = { ...(node.data ?? {}), assetUuid };
  await trx("canvas_documents").where({ id: 1 }).update({
    graph_json: JSON.stringify(graph),
    updated_at: new Date(now).toISOString(),
  });
  await trx("canvas_node_runs").where({ run_uuid: related.canvasRunUuid }).update({
    state: "succeeded",
    failure_text: null,
    updated_at: new Date(now).toISOString(),
  });
};

registerGenerationTaskFinalizer("视频生成", finalizeVideo);
registerGenerationTaskFinalizer("生成图片", finalizeImage);
registerGenerationTaskFinalizer("工作流图片生成", finalizeImage);
registerGenerationTaskFinalizer("角色图生成", finalizeImage);
registerGenerationTaskFinalizer("场景图生成", finalizeImage);
registerGenerationTaskFinalizer("道具图生成", finalizeImage);
registerGenerationTaskFinalizer("生成分镜图片", finalizeStoryboardImage);
registerGenerationTaskFinalizer("storyboard", finalizeStoryboardVendor);
registerGenerationTaskFinalizer("canvas-generation", finalizeCanvasGeneration);

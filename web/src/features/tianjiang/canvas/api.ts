import axios from "@/utils/axios";
import settingStore from "@/stores/setting";
import {
  CANVAS_IMPORTER_SCHEMA_VERSION,
  CANVAS_PORTABLE_FORMAT_VERSION,
} from "@/features/tianjiang/contracts";

export { CANVAS_IMPORTER_SCHEMA_VERSION, CANVAS_PORTABLE_FORMAT_VERSION };

export interface CanvasHomePlanInput {
  prompt: string;
  modelId?: string;
  attachmentAssetUuids?: string[];
  baseRevision: number;
  clientChatRequestId: string;
  requestDigest: string;
}

export interface CanvasHomePlanningPort {
  plan(projectUuid: string, input: CanvasHomePlanInput): Promise<unknown>;
}

export interface CanvasOpenedProject {
  projectUuid: string;
  runtimeGeneration: number;
}

function runtimeProject(projectUuid: string): string {
  return `/tianjiang/runtime/projects/${encodeURIComponent(projectUuid)}`;
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

export async function sha256HexUtf8(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function tjcanvasImportDigest(input: {
  projectUuid: string;
  archiveSha256: string;
  archiveSizeBytes: number;
  baseRevision: number;
  importerSchemaVersion: number;
}): Promise<string> {
  return sha256HexUtf8(canonicalizeJcs({
    operation: "tjcanvas-import",
    targetProjectUuid: input.projectUuid,
    archiveSha256: input.archiveSha256,
    archiveSizeBytes: input.archiveSizeBytes,
    baseRevision: input.baseRevision,
    importerSchemaVersion: input.importerSchemaVersion,
  }));
}

export function canvasImportActionDigest(importUuid: string, actionType: string, clientActionId: string): Promise<string> {
  return sha256HexUtf8(canonicalizeJcs({
    operation: actionType,
    importUuid,
    clientActionId,
  }));
}

/** 生产适配器指向计划 04 才会挂载的 home-plan；本阶段未挂载必须明确失败。 */
export function createCanvasHomePlanningPort(): CanvasHomePlanningPort {
  return {
    async plan(projectUuid, input) {
      const { data } = await axios.post(
        `/tianjiang/runtime/projects/${encodeURIComponent(projectUuid)}/canvas/home-plan`,
        input,
      );
      return data;
    },
  };
}

export async function openCanvasProject(projectUuid: string): Promise<CanvasOpenedProject> {
  const { data } = await axios.post(
    `/tianjiang/runtime/projects/${encodeURIComponent(projectUuid)}/open`,
  );
  const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const body = payload.data && typeof payload.data === "object"
    ? payload.data as Record<string, unknown>
    : payload;
  const runtimeGeneration = Number(body.runtimeGeneration);
  if (!Number.isSafeInteger(runtimeGeneration) || runtimeGeneration <= 0) {
    throw new Error("服务端未返回有效的项目运行时代次");
  }
  return {
    projectUuid: String(body.projectUuid ?? projectUuid),
    runtimeGeneration,
  };
}

export async function closeCanvasProject(
  projectUuid: string,
  runtimeGeneration: number | undefined,
): Promise<unknown> {
  if (!Number.isSafeInteger(Number(runtimeGeneration)) || Number(runtimeGeneration) <= 0) {
    // 中文注释：禁止用空代次关闭刚重开的同 UUID 项目运行时。
    throw new Error("缺少有效的项目运行时代次");
  }
  const { data } = await axios.post(
    `/tianjiang/runtime/projects/${encodeURIComponent(projectUuid)}/close`,
    { runtimeGeneration: Number(runtimeGeneration) },
  );
  return data;
}

export async function getCanvasDocument(projectUuid: string): Promise<unknown> {
  const { data } = await axios.get(`${runtimeProject(projectUuid)}/canvas/document`);
  return data;
}

export async function putCanvasDocument(projectUuid: string, input: {
  baseRevision: number;
  clientMutationId: string;
  document: unknown;
}): Promise<unknown> {
  const { data } = await axios.put(`${runtimeProject(projectUuid)}/canvas/document`, input);
  return data;
}

export async function listCanvasRevisions(projectUuid: string): Promise<unknown> {
  const { data } = await axios.get(`${runtimeProject(projectUuid)}/canvas/revisions`);
  return data;
}

export async function restoreCanvasRevision(projectUuid: string, revisionUuid: string, input: {
  baseRevision: number;
  clientMutationId: string;
}): Promise<unknown> {
  const { data } = await axios.post(
    `${runtimeProject(projectUuid)}/canvas/revisions/${encodeURIComponent(revisionUuid)}/restore`,
    input,
  );
  return data;
}

export async function listCanvasAssets(projectUuid: string): Promise<unknown> {
  const { data } = await axios.get(`${runtimeProject(projectUuid)}/canvas/assets`);
  return data;
}

export async function uploadCanvasAsset(projectUuid: string, input: {
  clientAssetMutationId: string;
  requestDigest: string;
  file: File;
}): Promise<unknown> {
  const form = new FormData();
  form.set("clientAssetMutationId", input.clientAssetMutationId);
  form.set("requestDigest", input.requestDigest);
  form.set("file", input.file);
  const { data } = await axios.post(`${runtimeProject(projectUuid)}/canvas/assets`, form);
  return data;
}

export async function deleteCanvasAsset(projectUuid: string, assetUuid: string, input: {
  clientAssetMutationId: string;
  requestDigest: string;
  expectedSha256: string;
}): Promise<unknown> {
  const { data } = await axios.delete(
    `${runtimeProject(projectUuid)}/canvas/assets/${encodeURIComponent(assetUuid)}`,
    { data: input },
  );
  return data;
}

export async function importCanvasNovel(projectUuid: string, input: {
  baseRevision: number;
  clientMutationId: string;
  text: string;
}): Promise<unknown> {
  const { data } = await axios.post(`${runtimeProject(projectUuid)}/canvas/imports/novel`, input);
  return data;
}

export async function importCanvasJson(projectUuid: string, input: {
  baseRevision: number;
  clientMutationId: string;
  document: unknown;
}): Promise<unknown> {
  const { data } = await axios.post(`${runtimeProject(projectUuid)}/canvas/imports/json`, input);
  return data;
}

export async function exportCanvasPortable(projectUuid: string): Promise<Blob> {
  const { data } = await axios.get(`${runtimeProject(projectUuid)}/canvas/export`, {
    responseType: "blob",
  });
  return data as Blob;
}

/** 字段顺序固定为 baseRevision → clientMutationId → requestDigest → archiveSha256 → archiveSizeBytes → file。 */
export async function importCanvasTjcanvas(projectUuid: string, input: {
  baseRevision: number;
  clientMutationId: string;
  requestDigest: string;
  archiveSha256: string;
  archiveSizeBytes: number;
  file: File;
}): Promise<unknown> {
  const form = new FormData();
  form.append("baseRevision", String(input.baseRevision));
  form.append("clientMutationId", input.clientMutationId);
  form.append("requestDigest", input.requestDigest);
  form.append("archiveSha256", input.archiveSha256);
  form.append("archiveSizeBytes", String(input.archiveSizeBytes));
  form.append("file", input.file);
  const { data } = await axios.post(`${runtimeProject(projectUuid)}/canvas/imports/tjcanvas`, form, {
    validateStatus: (status) => status === 202 || (status >= 200 && status < 300),
  });
  return data;
}

export async function getCanvasImportByClientMutation(projectUuid: string, clientMutationId: string): Promise<unknown> {
  const { data } = await axios.get(
    `${runtimeProject(projectUuid)}/canvas/imports/by-client-mutation/${encodeURIComponent(clientMutationId)}`,
  );
  return data;
}

export async function getCanvasImportStatus(projectUuid: string, importUuid: string): Promise<unknown> {
  const { data } = await axios.get(
    `${runtimeProject(projectUuid)}/canvas/imports/${encodeURIComponent(importUuid)}`,
  );
  return data;
}

export async function listActiveCanvasImports(projectUuid: string): Promise<unknown> {
  const { data } = await axios.get(`${runtimeProject(projectUuid)}/canvas/imports`);
  return data;
}

export async function cancelCanvasImport(projectUuid: string, importUuid: string, input: {
  clientActionId: string;
  requestDigest: string;
}): Promise<unknown> {
  const { data } = await axios.post(
    `${runtimeProject(projectUuid)}/canvas/imports/${encodeURIComponent(importUuid)}/cancel`,
    input,
  );
  return data;
}

export async function reconcileCanvasImport(projectUuid: string, importUuid: string, input: {
  clientActionId: string;
  requestDigest: string;
}): Promise<unknown> {
  const { data } = await axios.post(
    `${runtimeProject(projectUuid)}/canvas/imports/${encodeURIComponent(importUuid)}/reconcile`,
    input,
  );
  return data;
}

export async function listCanvasConversations(projectUuid: string): Promise<unknown> {
  const { data } = await axios.get(`${runtimeProject(projectUuid)}/canvas/conversations`);
  return data;
}

export async function createCanvasConversation(projectUuid: string): Promise<unknown> {
  const { data } = await axios.post(`${runtimeProject(projectUuid)}/canvas/conversations`, {});
  return data;
}

export async function listCanvasMessages(projectUuid: string, conversationUuid: string): Promise<unknown> {
  const { data } = await axios.get(
    `${runtimeProject(projectUuid)}/canvas/conversations/${encodeURIComponent(conversationUuid)}/messages`,
  );
  return data;
}

/** 中文注释：聊天只走 /tianjiang/runtime/projects/:uuid/canvas/chat 相对路径，Axios 已含 /api。 */
export interface CanvasChatStreamEvent {
  delta?: string;
  done?: boolean;
  planUuid?: string;
  source?: string;
  [key: string]: unknown;
}

export async function postCanvasChat(projectUuid: string, input: {
  conversationUuid: string;
  prompt: string;
  modelId?: string;
  skillId?: string;
  attachmentAssetUuids: string[];
  referencedNodeUuids: string[];
  baseRevision: number;
  clientChatRequestId: string;
  requestDigest: string;
}, onEvent?: (event: CanvasChatStreamEvent) => void): Promise<CanvasChatStreamEvent> {
  const baseUrl = settingStore().baseUrl.replace(/\/$/, "");
  const response = await fetch(`${baseUrl}${runtimeProject(projectUuid)}/canvas/chat`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(input),
  });
  if (!response.ok || !response.body) {
    const failure = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
    throw failure;
  }
  if (!String(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    throw new Error("画布聊天服务未返回 SSE 数据流");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let finalEvent: CanvasChatStreamEvent = {};
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const frames = pending.split(/\r?\n\r?\n/);
    pending = done ? "" : frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const event = JSON.parse(data) as CanvasChatStreamEvent;
      finalEvent = { ...finalEvent, ...event };
      onEvent?.(event);
    }
    if (done) break;
  }
  return finalEvent;
}

export async function applyCanvasChatPlan(projectUuid: string, planUuid: string, input: {
  baseRevision: number;
  clientMutationId: string;
}): Promise<unknown> {
  const { data } = await axios.post(
    `${runtimeProject(projectUuid)}/canvas/plans/${encodeURIComponent(planUuid)}/apply`,
    input,
  );
  return data;
}

export async function previewCanvasExecution(projectUuid: string, input: {
  baseRevision: number;
  nodeUuids: string[];
}): Promise<unknown> {
  const { data } = await axios.post(`${runtimeProject(projectUuid)}/canvas/executions/preview`, input);
  return data;
}

export async function confirmCanvasExecution(projectUuid: string, input: {
  confirmationUuid: string;
  requestDigest: string;
  baseRevision: number;
  clientRequestId: string;
}): Promise<unknown> {
  const { data } = await axios.post(`${runtimeProject(projectUuid)}/canvas/executions/confirm`, input, {
    validateStatus: (status) => status === 202 || (status >= 200 && status < 300),
  });
  return data;
}

export async function listCanvasExecutions(projectUuid: string): Promise<unknown> {
  const { data } = await axios.get(`${runtimeProject(projectUuid)}/canvas/executions`);
  return data;
}

export async function cancelCanvasExecution(projectUuid: string, runUuid: string, input: {
  clientActionId: string;
  requestDigest: string;
}): Promise<unknown> {
  const { data } = await axios.post(
    `${runtimeProject(projectUuid)}/canvas/executions/${encodeURIComponent(runUuid)}/cancel`,
    input,
  );
  return data;
}

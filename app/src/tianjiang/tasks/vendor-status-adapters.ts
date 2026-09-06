import type { Knex } from "knex";
import jsonwebtoken from "jsonwebtoken";
import { transform } from "sucrase";

import runCode from "@/utils/vm";
import { getCode } from "@/utils/vendor";
import { loadVendorPrivateInputs } from "@/utils/vendor-private-config";
import {
  registerGenerationTaskStatusAdapter,
  type GenerationTaskIdentity,
  type RemoteGenerationResult,
} from "./generation-task-recovery";
import {
  inferArtifactMediaType,
  type NormalizedGenerationArtifact,
} from "./generation-task-artifacts";

type TrustedFetch = typeof fetch;

interface VendorRow {
  id: string;
  enable?: number;
}

/**
 * 每次用户数据库激活时，根据进行中任务和已启用供应商登记只读状态查询器。
 * 查询器只接受已持久化的远端任务 ID，接口中不存在创建或重新提交能力。
 */
export async function registerProductionGenerationStatusAdapters(
  database: Knex,
  dependencies: {
    trustedFetch?: TrustedFetch;
    codeLoader?: (provider: string) => string;
    /** 测试可注入；生产默认账号 db2（供应商/密钥不在项目库） */
    accountConfigDatabase?: Knex;
  } = {},
): Promise<void> {
  // 任务行可能在项目库；供应商启用状态与密钥必须来自账号配置库。
  // 生产路径失败关闭：禁止账号库解析失败后回退项目 database。
  let configDb = dependencies.accountConfigDatabase;
  if (!configDb) {
    const { accountDatabase } = await import("@/utils/db");
    configDb = accountDatabase();
  }

  const pending = await database("o_tasks")
    .where("state", "进行中")
    .whereNotNull("provider")
    .distinct("provider") as Array<{ provider: string }>;
  const enabled = await configDb<VendorRow>("o_vendorConfig")
    .where("enable", 1)
    .select("id");
  const providerIds = [...new Set([
    ...pending.map((row) => row.provider),
    ...enabled.map((row) => row.id),
  ])].filter((id): id is string => typeof id === "string" && id.length > 0);

  for (const provider of providerIds) {
    // 待恢复任务的 provider 即使未 enable 也要登记查询器；行必须存在于账号库
    const row = await configDb<VendorRow>("o_vendorConfig").where("id", provider).first();
    if (!row) continue;
    const inputs = await loadVendorPrivateInputs(provider, configDb);
    const code = (dependencies.codeLoader ?? getCode)(provider);
    let dynamicQuery: ((remoteTaskId: string, task: GenerationTaskIdentity) => Promise<unknown>) | undefined;
    if (code.trim()) {
      const running = runCode(transform(code, { transforms: ["typescript"] }).code);
      if (running.vendor?.inputValues) Object.assign(running.vendor.inputValues, inputs);
      if (typeof running.queryTask === "function") dynamicQuery = running.queryTask;
    }
    const builtin = createProductionProviderStatusAdapter(
      provider,
      inputs,
      dependencies.trustedFetch ?? fetch,
    );
    if (!dynamicQuery && !builtin) continue;
    registerGenerationTaskStatusAdapter(provider, async (remoteTaskId, task) => {
      if (dynamicQuery) return normalizeRemoteState(await dynamicQuery(remoteTaskId, task));
      return builtin!(remoteTaskId, task);
    });
  }
}

/**
 * 内置供应商状态查询适配器。fetch 参数仅用于隔离测试，生产固定使用 Node 受信网络栈。
 */
export function createProductionProviderStatusAdapter(
  provider: string,
  inputs: Record<string, string>,
  trustedFetch: TrustedFetch = fetch,
): ((remoteTaskId: string, task: GenerationTaskIdentity) => Promise<RemoteGenerationResult>) | undefined {
  // 中文注释：佳速新协议创建与查询共用 baseUrl，空值及旧官方域名统一升级。
  const configuredJiasuBase = (inputs.baseUrl || "").trim().replace(/\/+$/, "");
  const baseUrl = provider === "tianjiang"
    ? !configuredJiasuBase || /^https:\/\/js\.jiasuapi\.com(?:\/v1)?$/i.test(configuredJiasuBase)
      ? "https://ai.jiasuapi.com/v1" : configuredJiasuBase
    : inputs.mediaBaseUrl || inputs.baseUrl;
  if (!baseUrl) return undefined;
  const url = (suffix: string) => joinHTTPS(baseUrl, suffix);
  const bearer = () => ({
    "content-type": "application/json",
    authorization: `Bearer ${(inputs.apiKey || "").replace(/^Bearer\s+/i, "")}`,
  });

  if (provider === "atlascloud") {
    return async (id) => normalizeRemoteState(await requestJSON(
      trustedFetch,
      url(`/model/prediction/${encodeURIComponent(id)}`),
      { headers: bearer() },
    ));
  }
  if (provider === "grsai") {
    return async (id) => normalizeRemoteState(await requestJSON(
      trustedFetch,
      url("/v1/draw/result"),
      { method: "POST", headers: bearer(), body: JSON.stringify({ id }) },
    ));
  }
  if (provider === "minimax") {
    return async (id) => normalizeRemoteState(await requestJSON(
      trustedFetch,
      `${url("/v1/query/video_generation")}?task_id=${encodeURIComponent(id)}`,
      { headers: bearer() },
    ));
  }
  if (provider === "tianjiang") {
    return async (id, task) => {
      const hint = task.remoteStatusHint || "";
      const kind = /\/images?\//.test(hint) ? "image"
        : /\/videos?\//.test(hint) ? "video"
          : /图|image/i.test(task.taskClass || "") ? "image" : "video";
      const response = await trustedFetch(url(`/${kind === "image" ? "images" : "videos"}/tasks/${encodeURIComponent(id)}`), {
        method: "GET", headers: bearer(),
      });
      if (response.status === 404) return { state: "not_found", reason: "远端任务不存在" };
      if (response.status === 410) return { state: "failed", reason: "任务已结束或媒体已过保留期" };
      if (!response.ok) throw new Error(`生成任务查询失败: HTTP ${response.status}`);
      const result = normalizeJiasuTaskState(await response.json(), kind);
      if (result.reason) {
        // 中文注释：错误文本来自远端，不能反射账号密钥、Bearer 或内联素材。
        const key = (inputs.apiKey || "").trim().replace(/^Bearer\s+/i, "");
        result.reason = (key ? result.reason.split(key).join("[REDACTED_SECRET]") : result.reason)
          .replace(/Bearer\s+[^\s;,]+/gi, "Bearer [REDACTED_SECRET]")
          .replace(/data:[^\s;,]+;base64,[a-z0-9+/=]+/gi, "[REDACTED_MEDIA]")
          .slice(0, 1000);
      }
      return result;
    };
  }
  if (provider === "vidu") {
    return async (id) => normalizeRemoteState(await requestJSON(
      trustedFetch,
      url(`/tasks/${encodeURIComponent(id)}/creations`),
      {
        headers: {
          "content-type": "application/json",
          authorization: `Token ${(inputs.apiKey || "").replace(/^Token\s+/i, "")}`,
        },
      },
    ));
  }
  if (provider === "volcengine" || provider === "volcengineSd2") {
    return async (id) => normalizeRemoteState(await requestJSON(
      trustedFetch,
      url(`/contents/generations/tasks/${encodeURIComponent(id)}`),
      { headers: bearer() },
    ));
  }
  if (provider === "klingai") {
    return async (id, task) => {
      const accessKey = inputs.accessKey;
      const secretKey = inputs.secretKey;
      if (!accessKey || !secretKey) throw new Error("可灵状态查询缺少受信后端密钥");
      const now = Math.floor(Date.now() / 1000);
      const token = jsonwebtoken.sign(
        { iss: accessKey, exp: now + 1800, nbf: now - 5 },
        secretKey,
        { algorithm: "HS256", header: { alg: "HS256", typ: "JWT" } },
      );
      const hint = task.remoteStatusHint;
      if (!hint || !hint.startsWith("/") || hint.includes("..")) {
        throw new Error("可灵任务缺少安全状态端点提示");
      }
      return normalizeRemoteState(await requestJSON(
        trustedFetch,
        url(`${hint}/${encodeURIComponent(id)}`),
        { headers: { authorization: `Bearer ${token}` } },
      ));
    };
  }
  return undefined;
}

/** 中文注释：佳速图片与视频的公开回执不同，不能经过通用 numeric code 或旧 url 解析。 */
export function normalizeJiasuTaskState(payload: unknown, kind: "image" | "video"): RemoteGenerationResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { state: "temporary_error", reason: "任务查询响应格式无效" };
  }
  const record = payload as Record<string, any>;
  if (kind === "image" && record.code !== "success") {
    return { state: "temporary_error", reason: "图片任务查询回执无效" };
  }
  const data = kind === "image" ? record.data : record;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { state: "temporary_error", reason: "任务查询响应格式无效" };
  }
  const status = String(data.status || "").toLowerCase();
  if (status === "failure" || status === "failed") {
    const reason = kind === "image" ? data.fail_reason : data.error?.message;
    return { state: "failed", reason: typeof reason === "string" && reason.trim() ? reason.trim() : "生成任务失败" };
  }
  if (status === (kind === "image" ? "success" : "completed")) {
    const candidates = kind === "image" ? [data.result_url] : Array.isArray(data.result_urls) ? data.result_urls : [];
    const remoteUrl = candidates.find((value: unknown) => {
      if (typeof value !== "string") return false;
      try {
        const parsed = new URL(value);
        return parsed.protocol === "https:" && !parsed.username && !parsed.password;
      } catch { return false; }
    });
    return remoteUrl ? { state: "completed", artifact: { mediaType: kind, sourceKind: "remote_url", remoteUrl: remoteUrl.trim() } }
      : { state: "temporary_error", reason: "任务已完成，但查询响应缺少有效结果 URL" };
  }
  const pending = kind === "image" ? ["not_start", "submitted", "queued", "in_progress", "unknown"]
    : ["queued", "in_progress", "unknown"];
  return pending.includes(status) ? { state: "pending" }
    : { state: "temporary_error", reason: "任务查询响应缺少有效状态" };
}

export function normalizeRemoteState(payload: unknown): RemoteGenerationResult {
  if (!payload || typeof payload !== "object") {
    return { state: "temporary_error", reason: "供应商状态响应格式无效" };
  }
  const record = payload as Record<string, any>;
  if (typeof record.state === "string" && [
    "pending", "completed", "failed", "not_found", "temporary_error",
  ].includes(record.state)) {
    return withArtifact({
      state: record.state as RemoteGenerationResult["state"],
      reason: stringReason(record),
    }, record);
  }
  if (record.completed === true) {
    return record.error
      ? { state: "failed", reason: String(record.error) }
      : withArtifact({ state: "completed" }, record);
  }
  if (record.completed === false && record.error) {
    return { state: "temporary_error", reason: String(record.error) };
  }
  if (record.code !== undefined && Number(record.code) !== 0) {
    return { state: "failed", reason: String(record.msg || record.message || "供应商查询失败") };
  }
  if (record.base_resp?.status_code !== undefined && Number(record.base_resp.status_code) !== 0) {
    return { state: "failed", reason: String(record.base_resp.status_msg || "供应商查询失败") };
  }
  const data = record.data && typeof record.data === "object" ? record.data : record;
  const raw = String(
    data.task_status
    ?? data.status
    ?? data.state
    ?? record.status
    ?? record.state
    ?? "",
  ).toLowerCase();
  if (["succeed", "succeeded", "success", "completed", "done", "active"].includes(raw)) {
    return withArtifact({ state: "completed" }, record);
  }
  if (["failed", "failure", "error", "expired", "cancelled", "canceled"].includes(raw)) {
    return { state: "failed", reason: stringReason(data) || stringReason(record) };
  }
  if (["not_found", "not found", "404"].includes(raw)) {
    return { state: "not_found", reason: stringReason(data) || "远端任务不存在" };
  }
  return { state: "pending" };
}

async function requestJSON(
  trustedFetch: TrustedFetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await trustedFetch(url, init);
  if (response.status === 404) return { state: "not_found", reason: "远端任务不存在" };
  if (!response.ok) throw new Error(`供应商状态查询失败: HTTP ${response.status}`);
  return response.json();
}

function joinHTTPS(baseUrl: string, suffix: string): string {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("生产供应商状态接口必须使用 HTTPS");
  }
  parsed.search = "";
  parsed.hash = "";
  return `${parsed.toString().replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

function withArtifact(
  result: RemoteGenerationResult,
  record: Record<string, any>,
): RemoteGenerationResult {
  if (result.state !== "completed") return result;
  const artifact = extractNormalizedArtifact(record);
  return artifact ? { ...result, artifact } : result;
}

function extractNormalizedArtifact(record: Record<string, any>): NormalizedGenerationArtifact | undefined {
  const nested = record.data && typeof record.data === "object" ? record.data : record;
  // 中文注释：网络响应里的 localPath/filePath 一律不可信，只接受 HTTPS 定位信息。
  const url = firstHttpsUrl(
    nested.url,
    nested.video_url,
    nested.image_url,
    nested.audio_url,
    nested.file_url,
    nested.result_url,
    nested.output?.url,
    nested.result?.url,
    nested.output,
    nested.result,
    record.url,
    record.output?.url,
    record.artifact?.remoteUrl,
    record.artifact?.url,
  );
  if (url) {
    // 中文注释：动态适配器已知道业务类型，无后缀 CDN 地址不能再被推断成图片；字节校验仍由下载器执行。
    const declaredType = record.artifact?.mediaType;
    return {
      mediaType: ["image", "video", "audio"].includes(declaredType)
        ? declaredType : inferArtifactMediaType(url, nested.content_type ?? record.content_type ?? record.artifact?.contentType),
      sourceKind: "remote_url",
      remoteUrl: url,
      contentType: nested.content_type ?? record.content_type,
    };
  }
  if (record.artifact && typeof record.artifact === "object") {
    const artifact = record.artifact as NormalizedGenerationArtifact;
    if (artifact.sourceKind === "remote_url" && artifact.remoteUrl && /^https:\/\//i.test(artifact.remoteUrl)) {
      return {
        ...artifact,
        sourceKind: "remote_url",
        remoteUrl: artifact.remoteUrl,
        mediaType: ["image", "video", "audio"].includes(artifact.mediaType)
          ? artifact.mediaType : inferArtifactMediaType(artifact.remoteUrl, artifact.contentType),
      };
    }
  }
  return undefined;
}

function firstHttpsUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && /^https:\/\//i.test(value.trim())) return value.trim();
  }
  return undefined;
}

function stringReason(record: Record<string, any>): string | undefined {
  const value = record.reason
    ?? record.message
    ?? record.error?.message
    ?? record.failure_reason
    ?? record.failReason
    ?? record.task_status_msg;
  return value === undefined ? undefined : String(value);
}

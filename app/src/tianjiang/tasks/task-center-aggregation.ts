/**
 * 当前账号本地全局任务中心：聚合本机已存在且目录可见的 project.sqlite 中 o_tasks。
 * 不上传中央，不读取其他账号 runtime-users 目录。
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import getPath from "@/utils/getPath";
import { getStableDeviceUUID } from "../auth/device";
import { projectDirectory } from "../data/paths";
import { localLegacyProjectId } from "../runtime/local-project-id";
import { assertSafeProjectDatabasePath } from "./safe-project-db-path";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TaskCenterCatalogItem {
  projectUuid: string;
  name: string;
}

export interface TaskCenterProjectSource {
  projectUuid: string;
  projectName: string;
  legacyProjectId: number;
  /** 仅内部打开库使用，禁止写入 API 响应或日志 */
  databasePath: string;
}

export interface TaskCenterQuery {
  state?: string | null;
  taskClass?: string | null;
  projectUuid?: string | null;
  /** 迁移边界：仅当未提供 projectUuid 时尝试映射 */
  legacyProjectId?: number | null;
  page: number;
  limit: number;
}

export interface TaskCenterRow {
  id: number;
  taskClass: string | null;
  relatedObjects: string | null;
  model: string | null;
  describe: string | null;
  state: string | null;
  startTime: number | null;
  reason: string | null;
  projectId: number;
  projectUuid: string;
  projectName: string;
  /** 表格稳定主键，避免跨项目任务 id 冲突 */
  rowKey: string;
}

export interface TaskCenterListResult {
  data: TaskCenterRow[];
  total: number;
}

export function mapStoryboardTaskCenterState(status: string): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "claiming":
    case "submitting":
    case "submitted":
    case "querying":
    case "provider_completed":
    case "downloading":
    case "validating":
    case "waiting_project_lock":
      return "生成中";
    case "completed":
      return "已完成";
    case "failed_retryable":
    case "failed_fatal":
    case "postprocess_failed_retryable":
    case "postprocess_failed_fatal":
      return "生成失败";
    case "outcome_unknown":
      return "结果待确认";
    case "cancelled_local":
      return "已取消";
    case "waiting_origin_device":
      return "等待原设备";
    default:
      return "生成中";
  }
}

const STORYBOARD_TASK_SAFE_ERROR_REASONS: Readonly<Record<string, string>> = {
  DREAMINA_CLI_DISABLED: "即梦 CLI 已关闭",
  DREAMINA_CLI_NOT_INSTALLED: "即梦 CLI 未安装或无法执行",
  DREAMINA_CLI_NOT_LOGGED_IN: "即梦 CLI 未登录",
  DREAMINA_CLI_START_FAILED: "即梦 CLI 启动失败",
  DREAMINA_CLI_TIMEOUT: "即梦 CLI 执行超时",
  DREAMINA_CLI_OUTCOME_UNKNOWN: "提交结果待确认；为避免重复扣费不会自动重提",
  STORYBOARD_DREAMINA_CLI_UNAVAILABLE: "即梦 CLI 当前不可用",
  STORYBOARD_DREAMINA_MODE_UNSUPPORTED: "当前即梦 CLI 不支持所选生成模式",
  DREAMINA_PREFLIGHT_FAILED: "即梦任务本地预检失败",
  DREAMINA_RESULT_FILE_MISSING: "即梦结果文件缺失",
  DREAMINA_RESULT_VIDEO_INVALID: "即梦返回的视频文件无效",
  DREAMINA_RESULT_INSTALL_FAILED: "即梦结果写入项目失败",
  DREAMINA_UNKNOWN_MANUALLY_RESOLVED: "结果未知任务已由用户确认终结",
  VENDOR_PREPARE_FAILED: "当前视频模型配置或请求参数不可用",
  VENDOR_MEDIA_STAGING_FAILED: "参考素材暂存失败，请检查网络或稍后重试",
  VENDOR_GENERATION_FAILED: "普通供应商生成失败，请检查模型配置或稍后重试",
  VENDOR_GENERATION_RECOVERY_REQUIRED: "普通供应商耐久任务无法安全恢复，请重新提交",
  VENDOR_OUTCOME_UNKNOWN: "供应商提交结果待确认；为避免重复扣费不会自动重提",
};

/** 仅按稳定状态与错误码生成任务中心说明，禁止透传供应商原始文本。 */
export function describeStoryboardTaskCenterReason(
  status: string,
  errorCode: string | null,
  waitingOrigin: boolean,
  providerId = "dreamina-cli",
  errorSummary: string | null = null,
): string {
  if (waitingOrigin) return "任务需回到创建它的原设备继续处理";
  const vendor = providerId !== "dreamina-cli";
  const persistedVendorReason = String(errorSummary ?? "").trim();
  // 中文注释：普通供应商后台失败后优先展示其完整返回；提交接口仍保持立即入队。
  if (
    vendor
    && persistedVendorReason
    && ["failed_retryable", "failed_fatal", "postprocess_failed_retryable", "postprocess_failed_fatal"].includes(status)
  ) {
    return persistedVendorReason;
  }
  if (errorCode && STORYBOARD_TASK_SAFE_ERROR_REASONS[errorCode]) {
    return STORYBOARD_TASK_SAFE_ERROR_REASONS[errorCode];
  }
  switch (status) {
    case "queued":
      return "任务已进入本地队列，等待调度";
    case "claiming":
      return "本地调度器正在领取任务";
    case "submitting":
      return vendor ? "正在向普通供应商提交任务" : "正在向即梦 CLI 提交任务";
    case "submitted":
    case "querying":
      return "远端任务已提交，正在按设置的轮询间隔查询";
    case "provider_completed":
    case "downloading":
    case "validating":
    case "waiting_project_lock":
      return vendor
        ? "普通供应商已返回结果，正在写入当前项目"
        : "即梦 CLI 已返回结果，正在写入当前项目";
    case "completed":
      return vendor ? "普通供应商生成完成，结果已回写" : "即梦 CLI 生成完成，结果已回写";
    case "outcome_unknown":
      return "提交结果待确认；为避免重复扣费不会自动重提";
    case "cancelled_local":
      return "任务已在本机取消；远端任务可能仍需单独确认";
    case "failed_retryable":
    case "failed_fatal":
    case "postprocess_failed_retryable":
    case "postprocess_failed_fatal":
      return vendor
        ? "普通供应商生成失败，请检查模型配置或稍后重试"
        : "即梦任务生成失败，请检查 CLI 状态后重试";
    default:
      return vendor ? "普通供应商任务正在处理" : "即梦任务正在处理";
  }
}

export class TaskCenterError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 422, code = "TASK_CENTER_ERROR") {
    super(message);
    this.name = "TaskCenterError";
    this.status = status;
    this.code = code;
  }
}

/**
 * 枚举：中央/离线目录中可见 ∩ 当前账号 segment 下已存在 project.sqlite 的项目。
 */
export function listLocalTaskProjectSources(options: {
  dataRoot: string;
  userSegment: string;
  catalog: TaskCenterCatalogItem[];
}): TaskCenterProjectSource[] {
  const { dataRoot, userSegment, catalog } = options;
  if (!/^[a-f0-9]{32}$/i.test(userSegment)) {
    throw new TaskCenterError("账号存储标识无效", 403, "TASK_CENTER_FORBIDDEN");
  }
  const projectsRoot = path.resolve(dataRoot, "runtime-users", userSegment, "projects");
  const sources: TaskCenterProjectSource[] = [];
  for (const item of catalog) {
    const projectUuid = String(item.projectUuid ?? "").toLowerCase();
    if (!UUID_RE.test(projectUuid)) continue;
    let directory: string;
    try {
      directory = projectDirectory(dataRoot, projectUuid, userSegment);
    } catch {
      throw new TaskCenterError("项目目录越权或标识无效", 403, "TASK_CENTER_FORBIDDEN");
    }
    // 必须落在当前账号 projects 根下，禁止任何路径逃逸。
    if (!directory.startsWith(projectsRoot + path.sep)) {
      throw new TaskCenterError("项目目录越权", 403, "TASK_CENTER_FORBIDDEN");
    }
    const databasePath = path.join(directory, "project.sqlite");
    if (!fs.existsSync(databasePath)) continue;
    try {
      assertSafeProjectDatabasePath(dataRoot, databasePath);
    } catch {
      throw new TaskCenterError("项目数据库路径无效", 403, "TASK_CENTER_FORBIDDEN");
    }
    sources.push({
      projectUuid,
      projectName: String(item.name ?? "").trim() || projectUuid.slice(0, 8),
      legacyProjectId: localLegacyProjectId(projectUuid),
      databasePath,
    });
  }
  // 稳定顺序：按 projectUuid 字典序，保证聚合结果可复现。
  sources.sort((a, b) => a.projectUuid.localeCompare(b.projectUuid, "en"));
  return sources;
}

export function resolveTaskCenterFilterUuid(
  query: TaskCenterQuery,
  sources: TaskCenterProjectSource[],
): string | null {
  if (query.projectUuid) {
    const normalized = query.projectUuid.toLowerCase();
    if (!UUID_RE.test(normalized)) {
      throw new TaskCenterError("项目筛选标识无效", 400, "TASK_CENTER_BAD_FILTER");
    }
    if (!sources.some((item) => item.projectUuid === normalized)) {
      // 可见本机列表中不存在：当作无结果而非路径探测。
      return normalized;
    }
    return normalized;
  }
  if (query.legacyProjectId != null && Number.isSafeInteger(query.legacyProjectId)) {
    const hit = sources.find((item) => item.legacyProjectId === query.legacyProjectId);
    return hit?.projectUuid ?? `__missing_legacy_${query.legacyProjectId}`;
  }
  return null;
}

/**
 * 从多个项目库读取 o_tasks，过滤后统一排序分页。
 * 表缺失或空表 → 该项目贡献 0 行；库损坏 → 抛出不含路径的错误。
 */
export function aggregateTaskCenterList(
  sources: TaskCenterProjectSource[],
  query: TaskCenterQuery,
  openDatabase: (databasePath: string) => Database.Database = defaultOpenReadonly,
): TaskCenterListResult {
  const filterUuid = resolveTaskCenterFilterUuid(query, sources);
  const selected = filterUuid
    ? sources.filter((item) => item.projectUuid === filterUuid)
    : sources;

  const rows: TaskCenterRow[] = [];
  for (const source of selected) {
    rows.push(...readProjectTasks(source, query, openDatabase));
    rows.push(...readStoryboardGenerationTasks(source, query, openDatabase));
  }

  // 统一排序：startTime 降序，其次 id 降序，再 projectUuid 升序（完全确定）。
  rows.sort((a, b) => {
    const ta = a.startTime ?? 0;
    const tb = b.startTime ?? 0;
    if (tb !== ta) return tb - ta;
    if (b.id !== a.id) return b.id - a.id;
    return a.projectUuid.localeCompare(b.projectUuid, "en");
  });

  const total = rows.length;
  const page = Math.max(1, query.page);
  const limit = Math.max(1, Math.min(200, query.limit));
  const offset = (page - 1) * limit;
  return {
    data: rows.slice(offset, offset + limit),
    total,
  };
}

export function aggregateTaskCategories(
  sources: TaskCenterProjectSource[],
  openDatabase: (databasePath: string) => Database.Database = defaultOpenReadonly,
): Array<{ taskClass: string }> {
  const classes = new Set<string>();
  for (const source of sources) {
    for (const row of readProjectTasks(source, {}, openDatabase)) {
      if (row.taskClass) classes.add(row.taskClass);
    }
  }
  return [...classes]
    .sort((a, b) => a.localeCompare(b, "en"))
    .map((taskClass) => ({ taskClass }));
}

export function listTaskCenterProjects(
  sources: TaskCenterProjectSource[],
): Array<{ projectUuid: string; name: string; id: number }> {
  return sources.map((item) => ({
    projectUuid: item.projectUuid,
    name: item.projectName,
    // 兼容旧前端 value=id：返回本地 legacy 数字，新前端应优先用 projectUuid
    id: item.legacyProjectId,
  }));
}

function readProjectTasks(
  source: TaskCenterProjectSource,
  query: Pick<TaskCenterQuery, "state" | "taskClass">,
  openDatabase: (databasePath: string) => Database.Database,
): TaskCenterRow[] {
  let database: Database.Database | undefined;
  try {
    database = openDatabase(source.databasePath);
    const hasTable = database
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'o_tasks' LIMIT 1",
      )
      .get() as { ok?: number } | undefined;
    if (!hasTable) return [];

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.taskClass) {
      conditions.push("taskClass = ?");
      params.push(query.taskClass);
    }
    if (query.state) {
      conditions.push("state = ?");
      params.push(query.state);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const statement = database.prepare(
      `SELECT id, taskClass, relatedObjects, model, describe, state, startTime, reason, projectId
       FROM o_tasks ${where}`,
    );
    const rawRows = statement.all(...params) as Array<Record<string, unknown>>;
    return rawRows.map((row) => {
      const id = Number(row.id);
      if (!Number.isSafeInteger(id)) {
        throw new TaskCenterError("项目任务数据不可用", 422, "TASK_CENTER_CORRUPT");
      }
      return {
        id,
        taskClass: asNullableString(row.taskClass),
        relatedObjects: asNullableString(row.relatedObjects),
        model: asNullableString(row.model),
        describe: asNullableString(row.describe),
        state: asNullableString(row.state),
        startTime: asNullableNumber(row.startTime),
        reason: asNullableString(row.reason),
        projectId: source.legacyProjectId,
        projectUuid: source.projectUuid,
        projectName: source.projectName,
        rowKey: `${source.projectUuid}:${id}`,
      };
    });
  } catch (error) {
    if (error instanceof TaskCenterError) throw error;
    // 损坏、锁死、权限：不暴露路径与底层细节。
    throw new TaskCenterError(
      `项目任务数据不可用（${source.projectUuid.slice(0, 8)}…）`,
      422,
      "TASK_CENTER_CORRUPT",
    );
  } finally {
    try {
      database?.close();
    } catch {
      // ignore
    }
  }
}

function readStoryboardGenerationTasks(
  source: TaskCenterProjectSource,
  query: Pick<TaskCenterQuery, "state" | "taskClass">,
  openDatabase: (databasePath: string) => Database.Database,
): TaskCenterRow[] {
  let database: Database.Database | undefined;
  try {
    database = openDatabase(source.databasePath);
    const hasTable = database
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'o_storyboardGenerationTask' LIMIT 1",
      )
      .get() as { ok?: number } | undefined;
    if (!hasTable) return [];
    const rawRows = database.prepare(
      `SELECT taskUuid, shotUuid, originDeviceUuid, providerId, modelName, status, errorCode, errorSummary, createdAt
       FROM o_storyboardGenerationTask`,
    ).all() as Array<Record<string, unknown>>;
    const currentDevice = getStableDeviceUUID(getPath());
    const rows: TaskCenterRow[] = [];
    for (const row of rawRows) {
      const taskUuid = String(row.taskUuid ?? "");
      if (!taskUuid) continue;
      const origin = String(row.originDeviceUuid ?? "");
      const status = String(row.status ?? "");
      const waitingOrigin = Boolean(origin && currentDevice && origin !== currentDevice)
        && !["completed", "failed_fatal", "failed_retryable", "cancelled_local"].includes(status);
      const state = waitingOrigin ? "等待原设备" : mapStoryboardTaskCenterState(status);
      if (query.state && query.state !== state && query.state !== status) continue;
      if (query.taskClass && query.taskClass !== "storyboard") continue;
      const createdAt = Number(row.createdAt ?? 0);
      const numericId = Number.parseInt(taskUuid.replace(/-/g, "").slice(0, 8), 16);
      rows.push({
        id: Number.isFinite(numericId) ? numericId : createdAt,
        taskClass: "storyboard",
        relatedObjects: taskUuid,
        model: asNullableString(row.modelName),
        describe: asNullableString(row.shotUuid),
        state,
        startTime: Number.isFinite(createdAt) ? createdAt : null,
        reason: describeStoryboardTaskCenterReason(
          status,
          asNullableString(row.errorCode),
          waitingOrigin,
          String(row.providerId ?? ""),
          asNullableString(row.errorSummary),
        ),
        projectId: source.legacyProjectId,
        projectUuid: source.projectUuid,
        projectName: source.projectName,
        rowKey: `${source.projectUuid}:storyboard:${taskUuid}`,
      });
    }
    return rows;
  } catch (error) {
    if (error instanceof TaskCenterError) throw error;
    throw new TaskCenterError(
      `项目任务数据不可用（${source.projectUuid.slice(0, 8)}…）`,
      422,
      "TASK_CENTER_CORRUPT",
    );
  } finally {
    try {
      database?.close();
    } catch {
      // ignore
    }
  }
}

function defaultOpenReadonly(databasePath: string): Database.Database {
  return new Database(databasePath, { readonly: true, fileMustExist: true });
}

function asNullableString(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

function asNullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

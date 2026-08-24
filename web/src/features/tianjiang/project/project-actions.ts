/**
 * 云端项目目录的编辑与方案 B 删除编排。
 * 错误消息只返回安全中文，禁止对象序列化与敏感诊断泄漏。
 */
import axios from "@/utils/axios";
import { buildClientAPIPath } from "@/features/tianjiang/contracts";
import {
  projectCatalogItem,
  type CatalogProject,
} from "@/features/tianjiang/project/catalog";
import { normalizeProjectBusinessType } from "@/features/tianjiang/project/create-project";
import { toLocalProjectId } from "@/features/tianjiang/project/local-project-id";
import type { FullProjectCreateFields } from "@/features/tianjiang/project/create-project-flow";
import projectStore from "@/stores/project";

const runtimeEndpoint = "/tianjiang/runtime/projects";

export interface DeleteCatalogProjectResult {
  cloudDeleted: true;
  localPurged: boolean;
  cleanupPending: boolean;
}

/** 将任意错误投影为单条安全中文提示。 */
export function safeProjectActionMessage(error: unknown, fallback: string): string {
  if (error == null) return fallback;
  if (typeof error === "string" && error.trim()) {
    return redact(error.trim());
  }
  const anyErr = error as {
    message?: unknown;
    msg?: unknown;
    response?: { data?: { message?: unknown; msg?: unknown; code?: unknown } };
    code?: unknown;
  };
  const raw =
    anyErr?.response?.data?.msg ??
    anyErr?.response?.data?.message ??
    anyErr?.message ??
    anyErr?.msg;
  if (typeof raw === "string" && raw.trim() && raw !== "[object Object]") {
    return redact(raw.trim());
  }
  return fallback;
}

function redact(text: string): string {
  return text
    .replace(/[A-Za-z]:\\[^\s]+/g, "[path]")
    .replace(/\/(?:home|Users|var|tmp)\/[^\s]+/g, "[path]")
    .replace(/[A-Za-z0-9_\-]{24,}/g, "[redacted]")
    .slice(0, 200);
}

export function canEditCatalogProject(project: CatalogProject): boolean {
  if (project.myRole === "viewer") return false;
  if (project.kind === "personal") return project.myRole === "owner";
  return project.myRole === "owner" || project.myRole === "editor";
}

/**
 * 是否允许真正执行删除。
 * 个人/团队均仅 owner；不得因 ownerUserId=0（团队语义）误判。
 * 权限只看 myRole === "owner"，禁止把 editor 提权。
 */
export function canDeleteCatalogProject(project: CatalogProject): boolean {
  return project.myRole === "owner";
}

/** 是否应展示删除入口（含禁用态）。团队 editor/viewer 也要看到禁用按钮。 */
export function shouldShowDeleteCatalogEntry(project: CatalogProject): boolean {
  if (project.kind === "team") return true;
  // 个人项目：非 owner 不应出现删除入口（通常不会发生）。
  return project.myRole === "owner";
}

/** 禁用删除时的安全中文原因；可删时返回空串。 */
export function catalogDeleteDisabledReason(project: CatalogProject): string {
  if (canDeleteCatalogProject(project)) return "";
  if (project.kind === "team") return "仅团队所有者可删除";
  return "仅项目所有者可删除";
}

export async function updateCatalogProject(
  projectUuid: string,
  input: {
    name: string;
    businessType: "novel" | "script" | "storyboard";
    description?: string;
    artStyle?: string;
    aspectRatio?: string;
    defaultLanguage?: string;
  },
): Promise<CatalogProject> {
  const response = await axios.patch(
    buildClientAPIPath("updateProject", { project_uuid: projectUuid }),
    {
      name: input.name.trim(),
      businessType: input.businessType,
      description: input.description ?? "",
      artStyle: input.artStyle ?? "",
      aspectRatio: input.aspectRatio ?? "",
      defaultLanguage: input.defaultLanguage ?? "",
    },
  );
  return projectCatalogItem(response.data ?? {});
}

/**
 * 立即提交当前项目快照。
 * Team 的后端实现会完成发布、释放锁并重新打开；若返回新运行时状态，必须同步刷新前端访问门。
 */
export async function syncCatalogProjectNow(projectUuid: string): Promise<void> {
  const response = await axios.post(
    `${runtimeEndpoint}/${encodeURIComponent(projectUuid)}/sync`,
  );
  const runtime = response.data?.runtime as
    | {
        projectUuid?: string;
        project?: Record<string, unknown>;
        accessMode?: "readwrite" | "readonly";
        readonlyReason?: string;
        lockHolder?: string;
      }
    | undefined;
  if (runtime?.project && runtime.projectUuid && runtime.accessMode) {
    projectStore().activateProject(runtime.project as any, {
      projectUuid: runtime.projectUuid,
      mode: runtime.accessMode,
      reason: runtime.readonlyReason ?? "",
      lockHolder: runtime.lockHolder ?? "",
    });
  }
}

/**
 * 云端项目完整编辑采用明确的三阶段顺序：中央摘要、本地完整字段、立即同步。
 * 任一阶段失败都向上抛出，编辑弹窗保持打开，禁止把半完成状态伪装成保存成功。
 */
export async function saveFullCatalogProject(
  projectUuid: string,
  localProjectId: unknown,
  fields: FullProjectCreateFields,
): Promise<CatalogProject> {
  const localId = requirePositiveLocalProjectId(localProjectId);
  const updated = await updateCatalogProject(projectUuid, {
    name: fields.name,
    businessType: normalizeProjectBusinessType(fields.projectType),
    description: fields.intro,
    artStyle: fields.artStyle,
    aspectRatio: fields.videoRatio,
    defaultLanguage: fields.defaultLanguage,
  });
  await axios.post("/project/editProject", {
    id: localId,
    name: fields.name,
    intro: fields.intro,
    type: fields.type,
    artStyle: fields.artStyle,
    directorManual: fields.directorManual,
    videoRatio: fields.videoRatio,
    imageModel: fields.imageModel,
    videoModel: fields.videoModel,
    projectType: fields.projectType || "novel",
    imageQuality: fields.imageQuality,
    mode: fields.mode,
  });
  await syncCatalogProjectNow(projectUuid);
  return updated;
}

/**
 * 方案 B：先中央回收站，成功后再清本地；中央失败绝不 purge。
 * cleanupPending 仅当本地 runtime 权威应答确认已持久化待办时为 true。
 * 请求未到达 runtime 时不得伪报「已排队」；依赖下次登录对账恢复。
 */
export async function deleteCatalogProject(
  projectUuid: string,
): Promise<DeleteCatalogProjectResult> {
  // 方案 B：中央回收站成功后才清本地；中央失败绝不 purge。
  await axios.post(
    buildClientAPIPath("deleteProject", { project_uuid: projectUuid }),
  );

  // 中央已确认删除：立即登记 tombstone 并从本地卡片隐藏（不按名称）。
  try {
    const { default: projectStore } = await import("@/stores/project");
    projectStore().rememberDeletedProject(projectUuid);
  } catch {
    // store 不可用时仍继续本地 purge，不阻断删除结果。
  }

  try {
    const response = await axios.post(
      `${runtimeEndpoint}/${encodeURIComponent(projectUuid)}/purge-local`,
    );
    const data = (response.data ?? {}) as {
      localPurged?: boolean;
      cleanupPending?: boolean;
      alreadyAbsent?: boolean;
    };
    return {
      cloudDeleted: true,
      localPurged: Boolean(data.localPurged || data.alreadyAbsent),
      // 仅采纳 runtime 明确返回的 durable 状态，禁止前端内存布尔冒充。
      cleanupPending: data.cleanupPending === true,
    };
  } catch {
    // 中央已成功但 purge-local 无权威应答：不得伪报 cleanupPending。
    // 下次同账号启动 reconcileOrphanLocalProjects 会补持久化待办。
    // tombstone 已写入，重启后仍不得重新展示该 UUID 卡片。
    return { cloudDeleted: true, localPurged: false, cleanupPending: false };
  }
}

/** 本地遗留项目：仅接受正安全整数 ID（复用叶子边界）。 */
export function requirePositiveLocalProjectId(value: unknown): number {
  try {
    return toLocalProjectId(value);
  } catch {
    throw new Error("本地项目标识无效");
  }
}

import projectStore from "@/stores/project";

const PROJECT_SCOPED_PREFIXES = [
  "/script/",
  "/scriptAgent/",
  "/assets/",
  "/assetsGenerate/",
  "/production/",
  "/novel/",
  "/project/",
  "/cornerScape/",
  "/general/",
  "/agents/",
  "/task/",
];

// 新建项目窗口中的手册属于当前账号 Skills，不依赖活动项目与项目写锁。
// 精确列举全部手册路由，避免把其他 /project/* 写入口错误放行。
const ACCOUNT_SCOPED_MANUAL_ROUTES = new Set([
  "/project/addDirectorManual",
  "/project/addVisualManual",
  "/project/deleteDirectorManual",
  "/project/deleteVisualManual",
  "/project/editDirectorlManual",
  "/project/editVisualManual",
  "/project/getVisualManual",
  "/project/queryDirectorManual",
  "/project/visualManual",
]);

// 任务中心三个读取 POST：账号级聚合，不依赖活动项目写锁。
const ACCOUNT_SCOPED_TASK_READ_ROUTES = new Set([
  "/task/getTaskApi",
  "/task/getTaskCategories",
  "/task/getProject",
]);

// 首页本地项目列表：账号级，不依赖活动项目写锁/打开状态。
const ACCOUNT_SCOPED_LOCAL_PROJECT_ROUTES = new Set([
  "/project/getProject",
]);

// 账号级模型/部署只读（db2），精确路径。
const ACCOUNT_SCOPED_MODEL_READ_ROUTES = new Set([
  "/project/getModelDetails",
]);

const EXPLICIT_READ_ROUTES = new Set([
  "/script/getScrptApi",
  "/script/exportScript",
  "/assets/getAssetsApi",
  "/assets/getImage",
  "/assets/getMaterialData",
  "/assets/batchGenerationData",
  "/production/getFlowData",
  "/production/workbench/getGenerateData",
  "/production/workbench/getVideoList",
  "/production/editImage/getImageFlow",
  "/production/editImage/getImageDefaultModle",
  "/novel/getNovel",
  "/novel/getNovelData",
  "/novel/getNovelIndex",
  "/novel/getNovelEventState",
  "/cornerScape/getAllAssets",
  "/cornerScape/pollingAudio",
  "/general/generalStatistics",
  "/general/getSingleProject",
  "/project/getProject",
  "/project/getVisualManual",
  "/project/queryDirectorManual",
  "/project/getModelDetails",
  // 剧本 Agent / 记忆：项目级纯读取；setPlanData/clearMemory 仍为 mutation
  "/scriptAgent/getPlanData",
  "/agents/getMemory",
  "/task/getTaskApi",
  "/task/getTaskCategories",
  "/task/getProject",
]);

export function isLegacyProjectMutation(method: string, pathname: string): boolean {
  const normalized = pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
  if (ACCOUNT_SCOPED_MANUAL_ROUTES.has(normalized)) return false;
  if (ACCOUNT_SCOPED_TASK_READ_ROUTES.has(normalized)) return false;
  if (ACCOUNT_SCOPED_LOCAL_PROJECT_ROUTES.has(normalized)) return false;
  if (ACCOUNT_SCOPED_MODEL_READ_ROUTES.has(normalized)) return false;
  if (!PROJECT_SCOPED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  if (["PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) return true;
  if (method.toUpperCase() !== "POST") return false;
  return !EXPLICIT_READ_ROUTES.has(normalized);
}

/**
 * 前端门只负责即时反馈；Node 统一授权仍是不可绕过的最终安全边界。
 */
export function assertLegacyProjectWriteAllowed(method: string, pathname: string): void {
  if (!isLegacyProjectMutation(method, pathname)) return;
  const mode = projectStore().access.mode;
  if (mode === "readwrite") return;
  throw new Error(mode === "recovery"
    ? "项目存在待处理恢复副本，当前禁止写入"
    : "项目当前只读，禁止写入");
}

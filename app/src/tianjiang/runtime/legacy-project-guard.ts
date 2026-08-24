const PROJECT_SCOPED_PREFIXES = [
  "/api/script/",
  "/api/scriptAgent/",
  "/api/assets/",
  "/api/assetsGenerate/",
  "/api/production/",
  "/api/novel/",
  "/api/project/",
  "/api/cornerScape/",
  "/api/general/",
  "/api/agents/",
  "/api/task/",
];

const GLOBAL_DESTRUCTIVE_ROUTES = new Set([
  "/api/other/deleteAllData",
  "/api/setting/dbConfig/clearData",
  "/api/setting/dbConfig/clearTable",
  "/api/setting/dbConfig/importData",
]);

const TRANSIENT_MEDIA_UPLOAD_ROUTES = new Set([
  "/api/assets/addAudioAssets",
  "/api/assets/saveAssets",
  "/api/assets/updateAudioAssets",
  "/api/assets/uploadClip",
  "/api/production/editImage/uploadImage",
]);

// 这些手册路由只读写当前认证账号的 Skills，和是否已打开项目、项目角色及项目锁无关。
// 必须精确列举，禁止按 /api/project/ 子前缀模糊放宽项目授权边界。
const ACCOUNT_SCOPED_MANUAL_ROUTES = new Set([
  "/api/project/addDirectorManual",
  "/api/project/addVisualManual",
  "/api/project/deleteDirectorManual",
  "/api/project/deleteVisualManual",
  "/api/project/editDirectorlManual",
  "/api/project/editVisualManual",
  "/api/project/getVisualManual",
  "/api/project/queryDirectorManual",
  "/api/project/visualManual",
]);

// 任务中心三个读取 POST：账号级聚合，不绑定「当前打开的单一项目」。
// 精确列举，禁止把 /api/task/retryRemoteTask 等写入口一并放宽。
const ACCOUNT_SCOPED_TASK_READ_ROUTES = new Set([
  "/api/task/getTaskApi",
  "/api/task/getTaskCategories",
  "/api/task/getProject",
]);

// 首页「我的项目」列表：账号级用户库 o_project，不得要求已打开中央项目。
// 否则无活动项目时 authorizeLegacy 抛「项目或子资源不存在」，Pinia 陈旧卡片会复活。
const ACCOUNT_SCOPED_LOCAL_PROJECT_ROUTES = new Set([
  "/api/project/getProject",
]);

// 账号级模型/部署只读：读 db2 部署与供应商，不依赖活动项目写锁。
// 精确路径，禁止按 /api/project/* 前缀放宽。
const ACCOUNT_SCOPED_MODEL_READ_ROUTES = new Set([
  "/api/project/getModelDetails",
]);

export type LegacyResourceTable =
  | "o_script"
  | "o_assets"
  | "o_storyboard"
  | "o_novel"
  | "o_videoTrack"
  | "o_video"
  | "o_imageFlow";

export type LegacyProjectTarget =
  {
    legacyProjectId?: number;
    resources: Array<{ table: LegacyResourceTable; id: number }>;
  };

const CLOUD_PROJECT_DETAIL_READ_ROUTE = "/api/general/getSingleProject";

/**
 * Express 会把一个尾随斜杠交给同一处理器；这里只兼容这一条已审核读取路由。
 * 双斜杠、子路径和相邻 general 路由不得被归一化，继续走默认写保护。
 */
function canonicalizeCloudProjectDetailReadRoute(pathname: string): string {
  return pathname === `${CLOUD_PROJECT_DETAIL_READ_ROUTE}/`
    ? CLOUD_PROJECT_DETAIL_READ_ROUTE
    : pathname;
}

// 旧应用读取也大量使用 POST；只有逐项审核过的只读路由可以绕过写门，其余项目路由默认按写处理。
const EXPLICIT_READ_ROUTES = new Set([
  "/api/project/getProject",
  "/api/script/getScrptApi",
  "/api/script/exportScript",
  "/api/assets/getAssetsApi",
  "/api/assets/getImage",
  "/api/assets/getMaterialData",
  "/api/assets/batchGenerationData",
  "/api/production/getFlowData",
  "/api/production/workbench/getGenerateData",
  "/api/production/workbench/getVideoList",
  "/api/production/editImage/getImageFlow",
  "/api/production/editImage/getImageDefaultModle",
  "/api/novel/getNovel",
  "/api/novel/getNovelData",
  "/api/novel/getNovelIndex",
  "/api/novel/getNovelEventState",
  "/api/cornerScape/getAllAssets",
  "/api/cornerScape/pollingAudio",
  "/api/general/generalStatistics",
  CLOUD_PROJECT_DETAIL_READ_ROUTE,
  // 剧本 Agent / Agent 记忆：纯读取（getPlanData 不得再 insert）
  "/api/scriptAgent/getPlanData",
  "/api/agents/getMemory",
  // 账号级模型详情
  "/api/project/getModelDetails",
  // 任务中心读取（亦在 ACCOUNT_SCOPED_TASK_READ_ROUTES，双登记保证 mutation=false）
  "/api/task/getTaskApi",
  "/api/task/getTaskCategories",
  "/api/task/getProject",
]);

/**
 * 旧应用大量读取也使用 POST，因此不能只按 HTTP method 判定。
 * 这里在统一入口按业务动作名识别写请求，后续新增写路由也会被通用动词覆盖。
 */
export function isLegacyProjectMutation(method: string, pathname: string): boolean {
  if (GLOBAL_DESTRUCTIVE_ROUTES.has(pathname)) return true;
  if (ACCOUNT_SCOPED_MANUAL_ROUTES.has(pathname)) return false;
  if (ACCOUNT_SCOPED_TASK_READ_ROUTES.has(pathname)) return false;
  if (ACCOUNT_SCOPED_LOCAL_PROJECT_ROUTES.has(pathname)) return false;
  if (ACCOUNT_SCOPED_MODEL_READ_ROUTES.has(pathname)) return false;
  if (!PROJECT_SCOPED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  if (["PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) return true;
  if (method.toUpperCase() !== "POST") return false;
  return !EXPLICIT_READ_ROUTES.has(canonicalizeCloudProjectDetailReadRoute(pathname));
}

/**
 * 只描述要核验的真实资源，不在分类层导入 DB。
 * 只要出现子资源 ID，就绝不信任同一请求体中的 projectId。
 */
export function describeLegacyProjectTarget(
  pathname: string,
  body: Record<string, unknown>,
): LegacyProjectTarget {
  // 云端完整项目编辑沿用旧接口 body.id；仅允许规范化后的精确路径，禁止放宽整个 general 前缀。
  const direct = pathname.startsWith("/api/project/")
    || canonicalizeCloudProjectDetailReadRoute(pathname) === CLOUD_PROJECT_DETAIL_READ_ROUTE
    ? positiveInteger(body.id ?? body.projectId ?? body.project_id)
    : positiveInteger(body.projectId ?? body.project_id);
  return {
    ...(direct ? { legacyProjectId: direct } : {}),
    resources: inferResources(pathname, body),
  };
}

function inferResources(
  pathname: string,
  body: Record<string, unknown>,
): Array<{ table: LegacyResourceTable; id: number }> {
  const resources: Array<{ table: LegacyResourceTable; id: number }> = [];
  const append = (table: LegacyResourceTable, value: unknown) => {
    const id = positiveInteger(value);
    if (id && !resources.some((item) => item.table === table && item.id === id)) {
      resources.push({ table, id });
    }
  };
  const flowId = positiveInteger(body.flowId ?? (pathname.includes("/editImage/") ? body.id : undefined));
  if (flowId) append("o_imageFlow", flowId);
  append("o_video", body.videoId);
  append(
    "o_videoTrack",
    body.trackId
    ?? body.videoTrackId
    ?? (pathname.includes("/workbench/") ? body.id : undefined),
  );
  append(
    "o_script",
    body.scriptId ?? (pathname.startsWith("/api/script/") ? body.id : undefined),
  );
  append(
    "o_storyboard",
    body.storyboardId ?? (pathname.includes("/storyboard/") ? body.id : undefined),
  );
  append("o_novel", body.novelId ?? (pathname.startsWith("/api/novel/") ? body.id : undefined));
  if (
    pathname.startsWith("/api/assets/")
    || pathname.startsWith("/api/assetsGenerate/")
    || pathname.startsWith("/api/cornerScape/")
    || body.assetsId !== undefined
  ) {
    append("o_assets", body.assetsId ?? body.assetId ?? body.id);
  }
  for (const value of arrayValues(body.assets)) append("o_assets", value);
  for (const value of arrayValues(body.assetIds)) append("o_assets", value);
  for (const value of arrayValues(body.scriptIds)) append("o_script", value);
  for (const value of arrayValues(body.storyboardIds)) append("o_storyboard", value);
  return resources;
}

export function isLegacyProjectRoute(pathname: string): boolean {
  return !ACCOUNT_SCOPED_MANUAL_ROUTES.has(pathname)
    && !ACCOUNT_SCOPED_TASK_READ_ROUTES.has(pathname)
    && !ACCOUNT_SCOPED_LOCAL_PROJECT_ROUTES.has(pathname)
    && !ACCOUNT_SCOPED_MODEL_READ_ROUTES.has(pathname)
    && PROJECT_SCOPED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function isGlobalLegacyDestructiveRoute(pathname: string): boolean {
  return GLOBAL_DESTRUCTIVE_ROUTES.has(pathname);
}

/**
 * 这些路由允许媒体仅在请求内以 Base64 传入，业务处理器必须先校验并落盘，
 * 数据库与同步快照仍只能保存相对路径或对象键。
 */
export function isTransientLegacyMediaUpload(pathname: string): boolean {
  return TRANSIENT_MEDIA_UPLOAD_ROUTES.has(pathname);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function arrayValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

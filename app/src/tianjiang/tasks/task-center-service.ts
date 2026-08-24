/**
 * 任务中心路由服务：绑定当前中央会话与本地聚合实现。
 */
import getPath from "@/utils/getPath";
import type { CentralSession } from "../auth/central-session";
import { syncCoordinator } from "../runtime/runtime";
import { userStorageSegment } from "../runtime/user-storage-context";
import {
  aggregateTaskCategories,
  aggregateTaskCenterList,
  listLocalTaskProjectSources,
  listTaskCenterProjects,
  TaskCenterError,
  type TaskCenterListResult,
  type TaskCenterQuery,
} from "./task-center-aggregation";

function requireSession(session: CentralSession | undefined): CentralSession {
  if (!session?.user?.id || !session.serverUrl) {
    throw new TaskCenterError("需要登录后访问任务中心", 401, "TASK_CENTER_AUTH");
  }
  return session;
}

function sourcesForSession(session: CentralSession) {
  const catalog = syncCoordinator.listProjects(session).map((item) => ({
    projectUuid: item.projectUuid,
    name: item.name,
  }));
  return listLocalTaskProjectSources({
    dataRoot: getPath(),
    userSegment: userStorageSegment({
      issuer: session.serverUrl,
      userId: session.user.id,
    }),
    catalog,
  });
}

export function taskCenterList(
  session: CentralSession | undefined,
  query: TaskCenterQuery,
): TaskCenterListResult {
  const active = requireSession(session);
  const sources = sourcesForSession(active);
  return aggregateTaskCenterList(sources, query);
}

export function taskCenterCategories(session: CentralSession | undefined) {
  const active = requireSession(session);
  return aggregateTaskCategories(sourcesForSession(active));
}

export function taskCenterProjects(session: CentralSession | undefined) {
  const active = requireSession(session);
  return listTaskCenterProjects(sourcesForSession(active));
}

export { TaskCenterError };

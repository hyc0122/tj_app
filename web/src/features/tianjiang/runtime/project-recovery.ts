import { openCatalogProject, type OpenProjectResult } from "@/features/tianjiang/project/catalog";
import projectStore from "@/stores/project";

interface ProjectRecoveryDependencies {
  openProject?: (projectUuid: string) => Promise<OpenProjectResult>;
}

const projectRecoveryInFlight = new Map<string, Promise<OpenProjectResult>>();

/**
 * Node 本地服务重启后内存中的 opened project 会丢失。
 * 当前页面仍停留在工作区时，必须用原 UUID 重新 open，并以服务端返回值重建访问门。
 */
export function recoverActiveProjectAfterRuntimeRestart(
  projectUuid: string,
  dependencies: ProjectRecoveryDependencies = {},
): Promise<OpenProjectResult> {
  const recoveryKey = projectUuid.trim().toLowerCase();
  const existing = projectRecoveryInFlight.get(recoveryKey);
  if (existing) return existing;

  const pending = (async () => {
    const openProject = dependencies.openProject ?? openCatalogProject;
    const opened = await openProject(projectUuid);
    if (opened.projectUuid !== projectUuid || !opened.project) {
      throw new Error("本地项目恢复响应无效");
    }
    projectStore().activateProject(opened.project, {
      projectUuid: opened.projectUuid,
      mode: opened.accessMode,
      reason: opened.readonlyReason ?? "",
      lockHolder: opened.lockHolder ?? "",
      runtimeGeneration: opened.runtimeGeneration,
    });
    // 中文注释：画布恢复必须回到原 UUID 编辑器，不得落到影视旧工作区。
    return opened;
  });
  let tracked!: Promise<OpenProjectResult>;
  tracked = pending().finally(() => {
    if (projectRecoveryInFlight.get(recoveryKey) === tracked) {
      projectRecoveryInFlight.delete(recoveryKey);
    }
  });
  projectRecoveryInFlight.set(recoveryKey, tracked);
  return tracked;
}

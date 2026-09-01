import imageListCacheStore from "@/stores/imageListCache";
import videoStore from "@/stores/video";
import { revokeTrackedObjectUrls } from "./object-url-registry";

export type ProjectRuntimeDisposeReason =
  | "project-switch"
  | "project-close"
  | "account-switch"
  | "workspace-leave";

type ProjectRuntimeReleaser = (projectId: string, reason: ProjectRuntimeDisposeReason) => void;

const releasers = new Map<string, ProjectRuntimeReleaser>();

/** Agent Store 在自身模块初始化时登记释放器，避免与 project store 形成循环依赖。 */
export function registerProjectRuntimeReleaser(name: string, releaser: ProjectRuntimeReleaser): void {
  releasers.set(name, releaser);
}

export interface ProjectRuntimeDisposeReport {
  projectId: string;
  reason: ProjectRuntimeDisposeReason;
  revokedObjectUrls: number;
}

/**
 * 统一销毁指定项目的完整前端运行态。
 * 不得调用 stopGenerate / cancel：切换项目不是取消已提交任务。
 */
export function disposeProjectRuntime(
  projectId: string,
  reason: ProjectRuntimeDisposeReason,
): ProjectRuntimeDisposeReport {
  const id = String(projectId ?? "").trim();
  if (!id) {
    return { projectId: "", reason, revokedObjectUrls: 0 };
  }

  let revokedObjectUrls = 0;
  try {
    revokedObjectUrls += revokeTrackedObjectUrls(id);
  } catch {
    // ignore
  }

  for (const releaser of releasers.values()) {
    try {
      releaser(id, reason);
    } catch {
      // 单个 Store 释放失败不得阻断其余清理
    }
  }

  try {
    imageListCacheStore().clearProjectCache(id);
  } catch {
    // ignore
  }

  try {
    const video = videoStore();
    video.releaseProjectRuntime?.();
  } catch {
    // ignore
  }

  return { projectId: id, reason, revokedObjectUrls };
}

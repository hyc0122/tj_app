import { AsyncLocalStorage } from "node:async_hooks";

import type { CentralSession } from "../auth/central-session";
import { getStableDeviceUUID } from "../auth/device";
import { prepareProjectDatabase } from "@/utils/db";
import getPath from "@/utils/getPath";
import { runWithProjectStorage, runWithUserStorage } from "./user-storage-context";
import { RuntimePermissionError } from "./sync-coordinator";
import { syncCoordinator } from "./runtime";

export type ProjectAccessMode = "read" | "write";

export interface ProjectOperationContext {
  projectUuid: string;
  access: ProjectAccessMode;
  session?: CentralSession;
}

export interface TeamWriteGuard {
  deviceUuid: string;
  lockId: string;
  fencingToken: number;
}

const teamWriteGuard = new AsyncLocalStorage<TeamWriteGuard | undefined>();

export function runWithTeamWriteGuard<T>(guard: TeamWriteGuard | undefined, run: () => T): T {
  return teamWriteGuard.run(guard, run);
}

export function enterTeamWriteGuard(guard: TeamWriteGuard | undefined): void {
  teamWriteGuard.enterWith(guard);
}

export function currentTeamWriteGuard(): TeamWriteGuard | undefined {
  return teamWriteGuard.getStore();
}

export function teamWriteGuardFromHeaders(headers: Record<string, unknown> | undefined): TeamWriteGuard | undefined {
  if (!headers) return undefined;
  const lockId = String(headers["x-tj-lock-id"] ?? headers["X-Tj-Lock-Id"] ?? "").trim();
  const deviceUuid = String(headers["x-tj-device-uuid"] ?? headers["X-Tj-Device-Uuid"] ?? "").trim();
  const fencingRaw = headers["x-tj-fencing-token"] ?? headers["X-Tj-Fencing-Token"];
  const fencingToken = Number(fencingRaw);
  if (!lockId && !deviceUuid && !Number.isFinite(fencingToken)) return undefined;
  return {
    lockId,
    deviceUuid,
    fencingToken: Number.isFinite(fencingToken) ? fencingToken : 0,
  };
}

/**
 * 双项目操作端口：先按 UUID 排序再打开/校验，避免反向并发死锁。
 * Team 写操作必须分别通过角色、设备、lockId、fencingToken 校验。
 */
export class ProjectOperationPort {
  async withProject<T>(
    session: CentralSession | undefined,
    projectUuid: string,
    access: ProjectAccessMode,
    operation: (context: ProjectOperationContext) => Promise<T>,
  ): Promise<T> {
    return this.withProjects(
      session,
      [projectUuid],
      new Map([[projectUuid, access]]),
      async (contexts) => operation(contexts.get(projectUuid)!),
    );
  }

  async withProjects<T>(
    session: CentralSession | undefined,
    projectUuids: readonly string[],
    accessByProjectUuid: ReadonlyMap<string, ProjectAccessMode>,
    operation: (contexts: ReadonlyMap<string, ProjectOperationContext>) => Promise<T>,
  ): Promise<T> {
    const unique = [...new Set(projectUuids)].sort((left, right) => left.localeCompare(right));
    if (!session?.user?.id || !session.serverUrl) {
      throw new RuntimePermissionError("缺少中央会话，无法打开项目运行时");
    }
    const identity = { issuer: session.serverUrl, userId: session.user.id };
    return runWithUserStorage(identity, async () => {
      const contexts = new Map<string, ProjectOperationContext>();
      for (const projectUuid of unique) {
        const access = accessByProjectUuid.get(projectUuid) ?? "read";
        await this.assertAccess(session, projectUuid, access);
        await prepareProjectDatabase(projectUuid);
        contexts.set(projectUuid, { projectUuid, access, session });
      }
      return operation(contexts);
    });
  }

  private async assertAccess(
    session: CentralSession,
    projectUuid: string,
    access: ProjectAccessMode,
  ): Promise<void> {
    const catalog = syncCoordinator.listProjects(session);
    const item = catalog.find((row: { projectUuid: string }) => row.projectUuid === projectUuid);
    if (!item) {
      throw new RuntimePermissionError("项目不存在或不可见");
    }
    if (access !== "write") return;
    if (item.myRole === "viewer" || item.openMode === "readonly") {
      throw new RuntimePermissionError("当前身份不能写入该项目");
    }
    if (item.kind !== "team") return;
    const guard = teamWriteGuard.getStore();
    if (!guard?.lockId || !guard.deviceUuid) {
      throw new RuntimePermissionError("Team 写入缺少设备或锁");
    }
    if (item.lockStatus !== "active") {
      throw new RuntimePermissionError("Team 编辑锁无效");
    }
    const expectedDevice = item.lockDeviceUuid || getStableDeviceUUID(getPath());
    if (guard.deviceUuid !== expectedDevice) {
      throw new RuntimePermissionError("Team 写入设备不匹配");
    }
    if (!item.lockId || guard.lockId !== item.lockId) {
      throw new RuntimePermissionError("Team 锁不匹配");
    }
    if (Number(item.fencingToken) !== guard.fencingToken) {
      throw new RuntimePermissionError("Team 栅栏令牌已失效");
    }
  }
}

export const projectOperationPort = new ProjectOperationPort();

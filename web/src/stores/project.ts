export interface Project {
  id: string;
  name: string;
  intro: string;
  type: string;
  artStyle: string | null;
  videoRatio: string | null;
  createTime: number;
  updatedAt: number;
  imageModel: string;
  videoModel: string;
  /** 分镜视频生成分辨率；旧项目为空时由界面规范为 720p。 */
  resolution?: string;
  projectType: "novel" | "script" | "storyboard";
  imageQuality: "1K" | "2K" | "4K" | "";
  mode: string;
  directorManual: string;
  /** 中央项目 UUID；有值时不得出现在「我的项目」本地遗留列表。 */
  projectUuid?: string;
  /** 中央不可达时的本地待确认标记（仅展示，不表示已删除）。 */
  localOnlyPending?: boolean;
  /** 一级共享资产来源；仅分镜项目可有。 */
  assetSourceProjectUuid?: string;
  myRole?: "owner" | "editor" | "viewer";
  openMode?: "editable" | "readonly";
}

export type ProjectAccessMode = "readwrite" | "readonly" | "recovery";

export interface ProjectAccess {
  projectUuid: string;
  mode: ProjectAccessMode;
  reason: string;
  lockHolder: string;
}

/** 按账号隔离的删除 tombstone：中央已确认删除/进回收站后本地不得再展示。 */
export interface ProjectTombstone {
  projectUuid: string;
  localId?: string;
  deletedAt: number;
}

export default defineStore(
  "project",
  () => {
    const allProject = ref<Project[]>([]);
    /** accountKey -> 已删除项目 tombstone 列表（只按 UUID/localId，禁止按名称）。 */
    const tombstonesByAccount = ref<Record<string, ProjectTombstone[]>>({});
    /** 当前会话账号键，用于隔离持久化缓存。 */
    const activeAccountKey = ref("");
    /** open 时记录 UUID → 本地数字 id 字符串，删除时按 UUID 精确剔除卡片。 */
    const uuidToLocalId = ref<Record<string, string>>({});

    const project = ref<Project | null>(null);
    // 访问模式不做持久化；每次打开都必须由当前会话和锁状态重新判定。
    const access = ref<ProjectAccess>({
      projectUuid: "",
      mode: "readonly",
      reason: "project_not_open",
      lockHolder: "",
    });
    const canWrite = computed(() => access.value.mode === "readwrite");

    function accountKeyOf(userId: number | string | null | undefined, issuer = "default"): string {
      const id = userId == null ? "" : String(userId).trim();
      if (!id) return "";
      return `${issuer}:${id}`;
    }

    function setActiveAccount(userId: number | string | null | undefined, issuer = "default"): void {
      const next = accountKeyOf(userId, issuer);
      if (next && activeAccountKey.value && next !== activeAccountKey.value) {
        // 切换账号：清空活动项目与本地列表展示，避免跨账号串数据。
        allProject.value = [];
        clearActiveProject();
      }
      activeAccountKey.value = next;
    }

    function currentTombstones(): ProjectTombstone[] {
      const key = activeAccountKey.value;
      if (!key) return [];
      return tombstonesByAccount.value[key] ?? [];
    }

    function isTombstoned(input: {
      projectUuid?: string | null;
      id?: string | number | null;
    }): boolean {
      const uuid = String(input.projectUuid ?? "").trim().toLowerCase();
      const localId = input.id == null ? "" : String(input.id).trim();
      return currentTombstones().some((row) => {
        if (uuid && row.projectUuid === uuid) return true;
        if (localId && row.localId && row.localId === localId) return true;
        return false;
      });
    }

    /**
     * 中央确认删除后登记 tombstone，并立即从 allProject 剔除。
     * 禁止按项目名称匹配。
     */
    function rememberDeletedProject(
      projectUuid: string,
      localId?: string | number | null,
    ): void {
      const uuid = projectUuid.trim().toLowerCase();
      if (!uuid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
        return;
      }
      const key = activeAccountKey.value;
      if (!key) return;
      const mappedLocal = localId != null && String(localId).trim()
        ? String(localId).trim()
        : uuidToLocalId.value[uuid];
      const list = [...(tombstonesByAccount.value[key] ?? [])];
      const existing = list.findIndex((row) => row.projectUuid === uuid);
      const next: ProjectTombstone = {
        projectUuid: uuid,
        ...(mappedLocal ? { localId: mappedLocal } : {}),
        deletedAt: Date.now(),
      };
      if (existing >= 0) list[existing] = { ...list[existing], ...next };
      else list.push(next);
      // 保留最近 500 条，防止无限膨胀。
      tombstonesByAccount.value = {
        ...tombstonesByAccount.value,
        [key]: list.slice(-500),
      };
      removeLocalProjectCard({ projectUuid: uuid, localId: mappedLocal });
      delete uuidToLocalId.value[uuid];
    }

    function removeLocalProjectCard(input: {
      projectUuid?: string;
      localId?: string | null;
    }): void {
      const uuid = String(input.projectUuid ?? "").trim().toLowerCase();
      const localId = input.localId == null ? "" : String(input.localId).trim();
      allProject.value = allProject.value.filter((item) => {
        const itemUuid = String(item.projectUuid ?? "").trim().toLowerCase();
        if (uuid && itemUuid && itemUuid === uuid) return false;
        if (localId && String(item.id) === localId) return false;
        return true;
      });
    }

    /** 展示用：去掉中央项目、tombstone 与跨账号残留。 */
    function filterVisibleLocalProjects(rows: Project[]): Project[] {
      return rows.filter((item) => {
        const uuid = String(item.projectUuid ?? "").trim();
        // 已关联中央 UUID 的只出现在云端目录。
        if (uuid) return false;
        if (isTombstoned({ projectUuid: item.projectUuid, id: item.id })) return false;
        return true;
      });
    }

    function activateProject(
      nextProject: Project,
      nextAccess: Omit<ProjectAccess, "projectUuid"> & { projectUuid?: string },
    ): void {
      const projectUuid = String(nextAccess.projectUuid ?? nextProject.projectUuid ?? "").trim();
      project.value = {
        ...nextProject,
        ...(projectUuid ? { projectUuid } : {}),
      };
      access.value = {
        projectUuid,
        mode: nextAccess.mode,
        reason: nextAccess.reason,
        lockHolder: nextAccess.lockHolder,
      };
      if (projectUuid && nextProject.id != null) {
        uuidToLocalId.value = {
          ...uuidToLocalId.value,
          [projectUuid.toLowerCase()]: String(nextProject.id),
        };
      }
    }

    function setAccessMode(
      mode: ProjectAccessMode,
      reason = "",
      lockHolder = "",
    ): void {
      access.value = { ...access.value, mode, reason, lockHolder };
    }

    function clearActiveProject(): void {
      project.value = null;
      access.value = {
        projectUuid: "",
        mode: "readonly",
        reason: "project_not_open",
        lockHolder: "",
      };
    }

    /** 登录/登出时清理陈旧活动项目与请求态，不跨账号保留活动上下文。 */
    function resetSessionProjectState(options?: { clearLocalList?: boolean }): void {
      clearActiveProject();
      uuidToLocalId.value = {};
      if (options?.clearLocalList) {
        allProject.value = [];
      } else {
        allProject.value = filterVisibleLocalProjects(allProject.value);
      }
    }

    return {
      allProject,
      tombstonesByAccount,
      activeAccountKey,
      uuidToLocalId,
      project,
      access,
      canWrite,
      accountKeyOf,
      setActiveAccount,
      isTombstoned,
      rememberDeletedProject,
      removeLocalProjectCard,
      filterVisibleLocalProjects,
      activateProject,
      setAccessMode,
      clearActiveProject,
      resetSessionProjectState,
    };
  },
  {
    persist: {
      // 本地列表与 tombstone 可缓存；活动项目和访问模式必须由本次中央打开响应重建。
      // tombstones 按账号键隔离，禁止清理 A 账号时影响 B。
      pick: ["allProject", "tombstonesByAccount", "uuidToLocalId"],
    },
  },
);

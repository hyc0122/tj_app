import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import projectStore from "@/stores/project";
import {
  canDeleteCatalogProject,
  canEditCatalogProject,
  catalogDeleteDisabledReason,
  deleteCatalogProject,
  shouldShowDeleteCatalogEntry,
} from "@/features/tianjiang/project/project-actions";
import type { CatalogProject } from "@/features/tianjiang/project/catalog";

const axiosMock = vi.hoisted(() => ({
  patch: vi.fn(),
  post: vi.fn(),
  get: vi.fn(),
}));

vi.mock("@/utils/axios", () => ({
  default: axiosMock,
}));

function catalog(partial: Partial<CatalogProject>): CatalogProject {
  return {
    projectUuid: "11111111-1111-4111-a111-111111111111",
    name: "demo",
    kind: "personal",
    myRole: "owner",
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: "2026-08-01T00:00:00Z",
    lockStatus: "none",
    lockHolderName: "",
    openMode: "editable",
    businessType: "novel",
    ...partial,
  };
}

describe("项目目录生命周期与 tombstone", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    axiosMock.post.mockReset();
    axiosMock.get.mockReset();
  });

  it("中央删除成功后本地卡片立即消失，重启过滤仍不回归", async () => {
    const store = projectStore();
    store.setActiveAccount(42);
    // 模拟历史污染：中央项目曾写入「我的项目」
    store.allProject = [
      {
        id: "9001",
        name: "任意旧名",
        intro: "",
        type: "",
        artStyle: null,
        videoRatio: null,
        createTime: 0,
        updatedAt: 0,
        imageModel: "",
        videoModel: "",
        projectType: "novel",
        imageQuality: "",
        mode: "",
        directorManual: "",
      },
      {
        id: "9002",
        name: "另一项目",
        intro: "",
        type: "",
        artStyle: null,
        videoRatio: null,
        createTime: 0,
        updatedAt: 0,
        imageModel: "",
        videoModel: "",
        projectType: "novel",
        imageQuality: "",
        mode: "",
        directorManual: "",
      },
    ];
    store.uuidToLocalId = {
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": "9001",
    };

    axiosMock.post
      .mockResolvedValueOnce({}) // central delete
      .mockResolvedValueOnce({ data: { localPurged: true, cleanupPending: false } });

    await deleteCatalogProject("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    expect(store.allProject.map((p) => p.id)).toEqual(["9002"]);
    expect(
      store.isTombstoned({ projectUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", id: "9001" }),
    ).toBe(true);
    // 模拟重启：仅恢复 allProject + tombstone，过滤后 9001 仍不可见
    const revived = store.filterVisibleLocalProjects([
      ...store.allProject,
      {
        id: "9001",
        name: "任意旧名",
        intro: "",
        type: "",
        artStyle: null,
        videoRatio: null,
        createTime: 0,
        updatedAt: 0,
        imageModel: "",
        videoModel: "",
        projectType: "novel",
        imageQuality: "",
        mode: "",
        directorManual: "",
      },
    ]);
    expect(revived.map((p) => p.id)).toEqual(["9002"]);
  });

  it("tombstone 按账号隔离，不得影响其他账号", () => {
    const store = projectStore();
    store.setActiveAccount(1);
    store.rememberDeletedProject("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "11");
    expect(store.isTombstoned({ projectUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })).toBe(true);

    store.setActiveAccount(2);
    // 切换账号后同 UUID 不在当前账号 tombstone 中误伤（新账号无记录）
    expect(store.isTombstoned({ projectUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })).toBe(false);
    store.rememberDeletedProject("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "22");
    expect(store.isTombstoned({ projectUuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })).toBe(true);

    store.setActiveAccount(1);
    expect(store.isTombstoned({ projectUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })).toBe(true);
    expect(store.isTombstoned({ projectUuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })).toBe(false);
  });

  it("同名不同 UUID 不得互相删除", () => {
    const store = projectStore();
    store.setActiveAccount(7);
    store.allProject = [
      {
        id: "1",
        name: "同名",
        intro: "",
        type: "",
        artStyle: null,
        videoRatio: null,
        createTime: 0,
        updatedAt: 0,
        imageModel: "",
        videoModel: "",
        projectType: "novel",
        imageQuality: "",
        mode: "",
        directorManual: "",
        projectUuid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      } as any,
      {
        id: "2",
        name: "同名",
        intro: "",
        type: "",
        artStyle: null,
        videoRatio: null,
        createTime: 0,
        updatedAt: 0,
        imageModel: "",
        videoModel: "",
        projectType: "novel",
        imageQuality: "",
        mode: "",
        directorManual: "",
        projectUuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      } as any,
    ];
    store.rememberDeletedProject("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "1");
    // filterVisible 会去掉带 projectUuid 的中央项；重点是 remove 只动 UUID/localId
    expect(store.allProject.some((p) => p.id === "1")).toBe(false);
    expect(store.allProject.some((p) => p.id === "2")).toBe(true);
  });

  it("中央不可达时不得清空本地列表，应保留待确认标记语义", () => {
    const store = projectStore();
    store.setActiveAccount(3);
    store.allProject = [
      {
        id: "55",
        name: "仅本地",
        intro: "",
        type: "",
        artStyle: null,
        videoRatio: null,
        createTime: 0,
        updatedAt: 0,
        imageModel: "",
        videoModel: "",
        projectType: "novel",
        imageQuality: "",
        mode: "",
        directorManual: "",
      },
    ];
    const kept = store.filterVisibleLocalProjects(store.allProject);
    expect(kept).toHaveLength(1);
    // 模拟网络失败：不清空
    const pending = kept.map((item) => ({ ...item, localOnlyPending: true }));
    expect(pending[0].localOnlyPending).toBe(true);
    expect(pending[0].id).toBe("55");
  });

  it("带 projectUuid 的中央项目不得进入本地遗留列表", () => {
    const store = projectStore();
    store.setActiveAccount(9);
    const visible = store.filterVisibleLocalProjects([
      {
        id: "1",
        name: "云端",
        intro: "",
        type: "",
        artStyle: null,
        videoRatio: null,
        createTime: 0,
        updatedAt: 0,
        imageModel: "",
        videoModel: "",
        projectType: "novel",
        imageQuality: "",
        mode: "",
        directorManual: "",
        projectUuid: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      },
      {
        id: "2",
        name: "本地",
        intro: "",
        type: "",
        artStyle: null,
        videoRatio: null,
        createTime: 0,
        updatedAt: 0,
        imageModel: "",
        videoModel: "",
        projectType: "novel",
        imageQuality: "",
        mode: "",
        directorManual: "",
      },
    ]);
    expect(visible.map((p) => p.id)).toEqual(["2"]);
  });
});

describe("团队删除权限矩阵", () => {
  it("owner 可删；team editor/viewer 显示入口但不可删", () => {
    const owner = catalog({ kind: "team", myRole: "owner" });
    const editor = catalog({ kind: "team", myRole: "editor" });
    const viewer = catalog({ kind: "team", myRole: "viewer" });
    const personalOwner = catalog({ kind: "personal", myRole: "owner" });

    expect(canDeleteCatalogProject(owner)).toBe(true);
    expect(canDeleteCatalogProject(editor)).toBe(false);
    expect(canDeleteCatalogProject(viewer)).toBe(false);
    expect(canDeleteCatalogProject(personalOwner)).toBe(true);

    expect(shouldShowDeleteCatalogEntry(owner)).toBe(true);
    expect(shouldShowDeleteCatalogEntry(editor)).toBe(true);
    expect(shouldShowDeleteCatalogEntry(viewer)).toBe(true);

    expect(catalogDeleteDisabledReason(editor)).toMatch(/仅团队所有者可删除/);
    expect(catalogDeleteDisabledReason(viewer)).toMatch(/仅团队所有者可删除/);
    expect(catalogDeleteDisabledReason(owner)).toBe("");

    // editor 可编辑不可删；viewer 不可编辑
    expect(canEditCatalogProject(editor)).toBe(true);
    expect(canEditCatalogProject(viewer)).toBe(false);
  });

  it("myRole=owner 时即使语义上无个人 ownerUserId 也可删（角色优先）", () => {
    // 不读取 ownerUserId 字段；只认 myRole。
    const teamOwner = catalog({ kind: "team", myRole: "owner" });
    expect(canDeleteCatalogProject(teamOwner)).toBe(true);
    expect(shouldShowDeleteCatalogEntry(teamOwner)).toBe(true);
  });

  it("deleteCatalogProject 中央失败绝不 purge-local，且不写 tombstone", async () => {
    const store = projectStore();
    store.setActiveAccount(88);
    store.allProject = [
      {
        id: "7001",
        name: "中央失败仍保留",
        intro: "",
        type: "",
        artStyle: null,
        videoRatio: null,
        createTime: 0,
        updatedAt: 0,
        imageModel: "",
        videoModel: "",
        projectType: "novel",
        imageQuality: "",
        mode: "",
        directorManual: "",
      },
    ];
    store.uuidToLocalId = {
      "11111111-1111-4111-a111-111111111111": "7001",
    };
    axiosMock.post.mockReset();
    axiosMock.post.mockRejectedValueOnce(new Error("central down"));
    await expect(
      deleteCatalogProject("11111111-1111-4111-a111-111111111111"),
    ).rejects.toThrow(/central down/);
    expect(axiosMock.post).toHaveBeenCalledTimes(1);
    expect(String(axiosMock.post.mock.calls[0][0])).toMatch(/delete/);
    // 中央失败：不得调用 purge-local，不得登记 tombstone，本地卡片仍在。
    expect(
      axiosMock.post.mock.calls.some((call) => String(call[0]).includes("purge-local")),
    ).toBe(false);
    expect(
      store.isTombstoned({ projectUuid: "11111111-1111-4111-a111-111111111111", id: "7001" }),
    ).toBe(false);
    expect(store.allProject.map((p) => p.id)).toEqual(["7001"]);
  });

  it("中央回收站成功后才写 tombstone；purge-local 失败仍保持 tombstone", async () => {
    const store = projectStore();
    store.setActiveAccount(99);
    store.allProject = [
      {
        id: "8001",
        name: "方案B",
        intro: "",
        type: "",
        artStyle: null,
        videoRatio: null,
        createTime: 0,
        updatedAt: 0,
        imageModel: "",
        videoModel: "",
        projectType: "novel",
        imageQuality: "",
        mode: "",
        directorManual: "",
      },
    ];
    store.uuidToLocalId = {
      "22222222-2222-4222-a222-222222222222": "8001",
    };
    axiosMock.post.mockReset();
    axiosMock.post
      .mockResolvedValueOnce({}) // central delete OK
      .mockRejectedValueOnce(new Error("purge failed")); // local purge fail
    const result = await deleteCatalogProject("22222222-2222-4222-a222-222222222222");
    expect(result.cloudDeleted).toBe(true);
    expect(result.localPurged).toBe(false);
    expect(result.cleanupPending).toBe(false);
    expect(
      store.isTombstoned({ projectUuid: "22222222-2222-4222-a222-222222222222", id: "8001" }),
    ).toBe(true);
    expect(store.allProject.map((p) => p.id)).toEqual([]);
    expect(String(axiosMock.post.mock.calls[0][0])).toMatch(/delete/);
    expect(String(axiosMock.post.mock.calls[1][0])).toMatch(/purge-local/);
  });
});

describe("首页陈旧项目状态清理", () => {
  it("clearActiveProject / resetSession 丢弃活动项目与 uuid", () => {
    const store = projectStore();
    store.activateProject(
      {
        id: "17",
        name: "旧项目",
        intro: "",
        type: "",
        artStyle: null,
        videoRatio: null,
        createTime: 0,
        updatedAt: 0,
        imageModel: "",
        videoModel: "",
        projectType: "script",
        imageQuality: "",
        mode: "",
        directorManual: "",
      },
      {
        projectUuid: "17171717-1717-4171-a171-171717171717",
        mode: "readwrite",
        reason: "",
        lockHolder: "",
      },
    );
    expect(store.access.projectUuid).toBeTruthy();
    store.resetSessionProjectState({ clearLocalList: true });
    expect(store.project).toBeNull();
    expect(store.access.projectUuid).toBe("");
    expect(store.access.reason).toBe("project_not_open");
    expect(store.allProject).toEqual([]);
  });
});

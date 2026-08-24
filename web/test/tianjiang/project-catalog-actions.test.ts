import { describe, expect, it, vi } from "vitest";

import {
  canDeleteCatalogProject,
  canEditCatalogProject,
  catalogDeleteDisabledReason,
  deleteCatalogProject,
  requirePositiveLocalProjectId,
  safeProjectActionMessage,
  shouldShowDeleteCatalogEntry,
  updateCatalogProject,
} from "@/features/tianjiang/project/project-actions";
import type { CatalogProject } from "@/features/tianjiang/project/catalog";

const axiosMock = vi.hoisted(() => ({
  patch: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/utils/axios", () => ({
  default: axiosMock,
}));

function project(partial: Partial<CatalogProject>): CatalogProject {
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

describe("云端项目编辑删除与权限", () => {
  it("viewer 只读：不可编辑/删除；owner 可删；team editor 可编辑不可删", () => {
    expect(canEditCatalogProject(project({ myRole: "viewer" }))).toBe(false);
    expect(canDeleteCatalogProject(project({ myRole: "viewer" }))).toBe(false);
    expect(canEditCatalogProject(project({ kind: "team", myRole: "editor" }))).toBe(true);
    expect(canDeleteCatalogProject(project({ kind: "team", myRole: "editor" }))).toBe(false);
    expect(canDeleteCatalogProject(project({ myRole: "owner" }))).toBe(true);
    // 团队 editor/viewer 仍展示禁用删除入口
    expect(shouldShowDeleteCatalogEntry(project({ kind: "team", myRole: "editor" }))).toBe(true);
    expect(shouldShowDeleteCatalogEntry(project({ kind: "team", myRole: "viewer" }))).toBe(true);
    expect(catalogDeleteDisabledReason(project({ kind: "team", myRole: "editor" }))).toMatch(
      /仅团队所有者可删除/,
    );
  });

  it("updateCatalogProject 仅提交 name/businessType", async () => {
    axiosMock.patch.mockResolvedValueOnce({
      data: {
        projectUuid: "11111111-1111-4111-a111-111111111111",
        name: "新名",
        kind: "personal",
        myRole: "owner",
        openMode: "editable",
        businessType: "script",
        currentVersion: 2,
        syncState: "synced",
        updatedAt: "2026-08-02T00:00:00Z",
        lockStatus: "none",
      },
    });
    const updated = await updateCatalogProject("11111111-1111-4111-a111-111111111111", {
      name: "新名",
      businessType: "script",
    });
    expect(updated.name).toBe("新名");
    expect(updated.businessType).toBe("script");
    expect(axiosMock.patch.mock.calls[0][1]).toMatchObject({
      name: "新名",
      businessType: "script",
    });
  });

  it("deleteCatalogProject 先云端删除再本地 purge；云端失败不 purge", async () => {
    axiosMock.post.mockReset();
    axiosMock.post
      .mockRejectedValueOnce(new Error("central down"));
    await expect(
      deleteCatalogProject("11111111-1111-4111-a111-111111111111"),
    ).rejects.toThrow(/central down/);
    expect(axiosMock.post).toHaveBeenCalledTimes(1);

    axiosMock.post.mockReset();
    axiosMock.post
      .mockResolvedValueOnce({}) // cloud delete
      .mockResolvedValueOnce({ data: { localPurged: true, cleanupPending: false } });
    const ok = await deleteCatalogProject("11111111-1111-4111-a111-111111111111");
    expect(ok).toEqual({ cloudDeleted: true, localPurged: true, cleanupPending: false });
    expect(String(axiosMock.post.mock.calls[0][0])).toMatch(/projects\/.+\/delete/);
    expect(String(axiosMock.post.mock.calls[1][0])).toMatch(/purge-local/);
  });

  it("purge-local 无权威应答时不得伪报 cleanupPending", async () => {
    axiosMock.post.mockReset();
    axiosMock.post
      .mockResolvedValueOnce({}) // 中央删除成功
      .mockRejectedValueOnce(new Error("runtime unreachable"));
    const result = await deleteCatalogProject("11111111-1111-4111-a111-111111111111");
    expect(result).toEqual({
      cloudDeleted: true,
      localPurged: false,
      cleanupPending: false,
    });
    // 中央删除只调用一次，不得重复
    expect(axiosMock.post.mock.calls.filter((c) => String(c[0]).includes("/delete"))).toHaveLength(1);
  });

  it("runtime 明确 cleanupPending=true 时才报告已排队", async () => {
    axiosMock.post.mockReset();
    axiosMock.post
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ data: { localPurged: false, cleanupPending: true } });
    const result = await deleteCatalogProject("11111111-1111-4111-a111-111111111111");
    expect(result.cleanupPending).toBe(true);
    expect(result.localPurged).toBe(false);
  });

  it("错误提示禁止 [object Object] 与路径泄露", () => {
    expect(safeProjectActionMessage({ message: "[object Object]" }, "失败")).toBe("失败");
    const safe = safeProjectActionMessage(
      { message: "boom E:\\secret\\path\\db.sqlite tokenABCDEFGHIJKLMNOPQRSTUV" },
      "失败",
    );
    expect(safe).not.toMatch(/E:\\|tokenABCDEFGHIJKLMNOPQRSTUV/);
  });

  it("本地项目 ID 必须为正安全整数", () => {
    expect(requirePositiveLocalProjectId(12)).toBe(12);
    expect(() => requirePositiveLocalProjectId("12")).not.toThrow();
    expect(() => requirePositiveLocalProjectId("abc")).toThrow(/无效/);
    expect(() => requirePositiveLocalProjectId(0)).toThrow(/无效/);
  });
});

// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/axios", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

vi.mock("@/router/index.ts", () => ({
  default: { push: vi.fn(), currentRoute: { value: { path: "/project" } } },
}));
import {
  buildCreateProjectBody,
  normalizeProjectBusinessType,
  projectCapabilities,
} from "@/features/tianjiang/project/create-project";
import { projectCatalogItem } from "@/features/tianjiang/project/catalog";

const SENTINEL = "RED_EXPECTED:WEB_CANVAS_PROJECT_TYPE";
const PROJECT_UUID = "11111111-1111-4111-a111-111111111111";
const REQUEST_ID = "22222222-2222-4222-a222-222222222222";

function catalogRow(overrides: Record<string, unknown> = {}) {
  return {
    projectUuid: PROJECT_UUID,
    name: "个人无限画布",
    kind: "personal",
    ownerUserId: 7,
    myRole: "owner",
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: "2026-08-31T00:00:00Z",
    lockStatus: "none",
    openMode: "editable",
    businessType: "canvas",
    ...overrides,
  };
}

describe("个人无限画布 Web 目录合同", () => {
  it("canvas 创建 body 固定 personal 且复用调用方请求 ID", () => {
    const body = buildCreateProjectBody({
      name: "我的无限画布",
      scope: "personal",
      businessType: "canvas",
      clientCreateRequestId: REQUEST_ID,
    } as never);
    expect(body.scope, SENTINEL).toBe("personal");
    expect(body.businessType, SENTINEL).toBe("canvas");
    expect((body as { clientCreateRequestId?: string }).clientCreateRequestId, SENTINEL).toBe(REQUEST_ID);
    expect(body.teamUuid, SENTINEL).toBeUndefined();
  });

  it("canvas 能力指向无限画布路径且显示无限画布", () => {
    expect(normalizeProjectBusinessType("canvas"), SENTINEL).toBe("canvas");
    const capabilities = projectCapabilities("canvas") as {
      workspacePath?: (uuid: string) => string;
      route?: string;
    };
    const path = capabilities.workspacePath?.(PROJECT_UUID) ?? capabilities.route;
    expect(path, SENTINEL).toBe(`/infinite-canvas/${encodeURIComponent(PROJECT_UUID)}`);
  });

  it("目录不得把 canvas 降级为 novel，team canvas 阻断整批", () => {
    const item = projectCatalogItem(catalogRow());
    expect(item.businessType, SENTINEL).toBe("canvas");
    expect(() => projectCatalogItem(catalogRow({ businessType: "movie" })), SENTINEL).toThrow(/PROJECT_BUSINESS_TYPE_INVALID|业务类型/);
    expect(
      () => projectCatalogItem(catalogRow({ kind: "team", teamUuid: PROJECT_UUID, businessType: "canvas" })),
      SENTINEL,
    ).toThrow(/CANVAS_TEAM_SCOPE_NOT_SUPPORTED|无限画布/);
  });
});

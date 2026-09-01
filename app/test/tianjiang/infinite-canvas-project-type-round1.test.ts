/**
 * 个人无限画布必须通过现有控制面校验、中央目录解析和 Runtime 错误码入口被识别。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { validateClientControlPlaneRequest } from "../../src/tianjiang/client-control-plane-contracts";
import { CentralRuntimeAdapter } from "../../src/tianjiang/runtime/central-runtime-adapter";

const SENTINEL = "RED_EXPECTED:APP_CANVAS_PROJECT_TYPE";
const CANVAS_UUID = "11111111-1111-4111-a111-111111111111";
const REQUEST_ID = "22222222-2222-4222-a222-222222222222";
const DEVICE_UUID = "33333333-3333-4333-a333-333333333333";

function catalogGateway(projects: Record<string, unknown>[]) {
  return {
    forwardBusinessRequest: async () => ({ projects }),
  };
}

function catalogRow(overrides: Record<string, unknown> = {}) {
  return {
    projectUuid: CANVAS_UUID,
    name: "个人无限画布",
    kind: "personal",
    ownerUserId: 7,
    myRole: "owner",
    currentVersion: 1,
    syncState: "synced",
    lastSyncedAt: null,
    updatedAt: "2026-08-31T00:00:00Z",
    lockStatus: "none",
    lockHolderName: "",
    openMode: "editable",
    businessType: "canvas",
    ...overrides,
  };
}

function createAdapter(projects: Record<string, unknown>[]) {
  return new CentralRuntimeAdapter(
    catalogGateway(projects) as never,
    { serverUrl: "https://api.j11.com.cn", user: { id: 7 } } as never,
    DEVICE_UUID,
  );
}

function errorCodeOf(error: unknown): string | undefined {
  return (error as { errorCode?: string } | null)?.errorCode;
}

test("个人 canvas 创建请求保留 clientCreateRequestId 且不含 teamUuid", () => {
  const body = validateClientControlPlaneRequest("createProject", {
    name: "我的无限画布",
    scope: "personal",
    businessType: "canvas",
    clientCreateRequestId: REQUEST_ID,
  });
  if (!body) {
    console.error(SENTINEL);
    assert.fail(SENTINEL);
  }
  assert.equal(body.businessType, "canvas", SENTINEL);
  assert.equal(body.scope, "personal", SENTINEL);
  assert.equal(body.clientCreateRequestId, REQUEST_ID, SENTINEL);
  assert.equal("teamUuid" in body, false, SENTINEL);
});

test("canvas + team 在发往中央前失败关闭", () => {
  assert.throws(
    () => validateClientControlPlaneRequest("createProject", {
      name: "团队画布",
      scope: "team",
      teamUuid: CANVAS_UUID,
      businessType: "canvas",
      clientCreateRequestId: REQUEST_ID,
    }),
    (error: unknown) => errorCodeOf(error) === "CANVAS_TEAM_SCOPE_NOT_SUPPORTED",
    SENTINEL,
  );
});

test("canvas 缺少请求 ID 不得由适配器补发新 ID", () => {
  assert.throws(
    () => validateClientControlPlaneRequest("createProject", {
      name: "缺幂等键",
      scope: "personal",
      businessType: "canvas",
    }),
    (error: unknown) => errorCodeOf(error) === "PROJECT_SCOPE_INVALID" || error instanceof Error,
    SENTINEL,
  );
  try {
    validateClientControlPlaneRequest("createProject", {
      name: "缺幂等键",
      scope: "personal",
      businessType: "canvas",
    });
    assert.fail(SENTINEL);
  } catch (error) {
    assert.notEqual(errorCodeOf(error), undefined, SENTINEL);
    assert.notEqual(errorCodeOf(error), "CANVAS_TEAM_SCOPE_NOT_SUPPORTED", SENTINEL);
  }
});

test("非 canvas 携带 clientCreateRequestId 必须拒绝且不得静默丢弃", () => {
  assert.throws(
    () => validateClientControlPlaneRequest("createProject", {
      name: "剧本",
      scope: "personal",
      businessType: "script",
      clientCreateRequestId: REQUEST_ID,
    }),
    (error: unknown) => errorCodeOf(error) === "PROJECT_CREATE_IDEMPOTENCY_FIELD_NOT_ALLOWED",
    SENTINEL,
  );
});

test("中央目录解析后 canvas 仍为 canvas，未知类型抛 PROJECT_BUSINESS_TYPE_INVALID", async () => {
  const catalog = await createAdapter([catalogRow()]).projectCatalog(7);
  assert.equal(catalog[0]?.businessType, "canvas", SENTINEL);
  await assert.rejects(
    () => createAdapter([catalogRow({ businessType: "movie" })]).projectCatalog(7),
    (error: unknown) => errorCodeOf(error) === "PROJECT_BUSINESS_TYPE_INVALID",
    SENTINEL,
  );
});

test("在线目录出现 team canvas 必须失败关闭", async () => {
  await assert.rejects(
    () => createAdapter([catalogRow({ kind: "team", teamUuid: CANVAS_UUID, ownerUserId: 0 })]).projectCatalog(7),
    (error: unknown) => errorCodeOf(error) === "CANVAS_TEAM_SCOPE_NOT_SUPPORTED",
    SENTINEL,
  );
});

/**
 * Task 3 RED：客户端控制面必须透传一级共享来源，并拒绝跨域/二级来源合同。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { API_CONTRACT } from "../../src/tianjiang/contracts";
import { validateClientControlPlaneRequest } from "../../src/tianjiang/client-control-plane-contracts";
import { CentralRuntimeAdapter } from "../../src/tianjiang/runtime/central-runtime-adapter";

const SOURCE_UUID = "22222222-2222-4222-a222-222222222222";
const CONSUMER_UUID = "11111111-1111-4111-a111-111111111111";

test("控制面创建合同保留一级来源并拒绝非分镜来源", () => {
  const shared = validateClientControlPlaneRequest("createProject", {
    name: "共享分镜",
    scope: "personal",
    businessType: "storyboard",
    assetSourceProjectUuid: SOURCE_UUID,
    description: "d",
    artStyle: "a",
    aspectRatio: "16:9",
    defaultLanguage: "zh-CN",
  });
  assert.equal(shared?.assetSourceProjectUuid, SOURCE_UUID);
  assert.throws(
    () => validateClientControlPlaneRequest("createProject", {
      name: "小说",
      scope: "personal",
      businessType: "novel",
      assetSourceProjectUuid: SOURCE_UUID,
    }),
    /来源|分镜|资产/,
  );
});

test("中央目录必须回读 assetSourceProjectUuid 供删除保护与网关使用", async () => {
  const adapter = new CentralRuntimeAdapter(
    {
      forwardBusinessRequest: async () => ({
        projects: [{
          projectUuid: CONSUMER_UUID,
          name: "共享分镜",
          kind: "personal",
          ownerUserId: 7,
          myRole: "owner",
          currentVersion: 1,
          syncState: "synced",
          lastSyncedAt: null,
          updatedAt: "2026-08-13T00:00:00Z",
          lockStatus: "none",
          lockHolderName: "",
          openMode: "editable",
          businessType: "storyboard",
          assetSourceProjectUuid: SOURCE_UUID,
        }],
      }),
    } as any,
    { serverUrl: "https://api.j11.com.cn", user: { id: 7 } } as any,
    "33333333-3333-4333-a333-333333333333",
  );
  const catalog = await adapter.projectCatalog(7);
  assert.equal(catalog[0]!.assetSourceProjectUuid, SOURCE_UUID);
});

test("版本清单合同必须包含外部资产引用数组", () => {
  const manifest = API_CONTRACT.typeSchemas.ProjectManifest;
  assert.equal(manifest.fields.external_asset_references, "ExternalAssetReference[]");
});

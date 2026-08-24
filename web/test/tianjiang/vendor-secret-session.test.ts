import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  VendorSecretSession,
  type VendorSecretRequester,
} from "../../src/features/tianjiang/vendor-secret-session";

it("进入或切换供应商时自动加载当前账号完整值，无需额外点击查看", async () => {
  const secretSession = new VendorSecretSession();
  const requests: Array<{ path: string; body?: unknown; options?: unknown }> = [];

  expect(secretSession.activate("alpha", { apiKey: "alpha-local-key" })).toStrictEqual({
    apiKey: "alpha-local-key",
  });
  expect(secretSession.values("alpha")).toStrictEqual({
    apiKey: "alpha-local-key",
  });
  expect(secretSession.activate("beta", { apiKey: "beta-local-key" })).toStrictEqual({
    apiKey: "beta-local-key",
  });
  expect(secretSession.values("alpha")).toStrictEqual({});
  expect(secretSession.values("beta")).toStrictEqual({
    apiKey: "beta-local-key",
  });
  expect(requests).toHaveLength(0);
});

it("当前供应商可直接编辑保存，切换和卸载清空上一账号内存值", async () => {
  const secretSession = new VendorSecretSession();
  const requests: Array<{ path: string; body?: unknown }> = [];
  const request: VendorSecretRequester = async (requestPath, body) => {
    requests.push({ path: requestPath, body });
    return { data: undefined };
  };
  secretSession.activate("alpha", { apiKey: "old" });
  await secretSession.save("alpha", { apiKey: "new" }, request);
  expect(requests.at(-1)).toStrictEqual({
    path: "/setting/vendorConfig/updateVendorInputs",
    body: { id: "alpha", inputValues: { apiKey: "new" } },
  });
  expect(secretSession.values("alpha")).toStrictEqual({ apiKey: "new" });

  secretSession.dispose();
  expect(secretSession.values("alpha")).toStrictEqual({});
  await expect(
    secretSession.save("alpha", { apiKey: "again" }, request),
  ).rejects.toThrow(/当前供应商/);
});

it("设置页密码型供应商字段也直接显示本人值，不使用密码掩码", () => {
  const workspace = readFileSync(
    path.join(
      process.cwd(),
      "src/components/setting/components/vendorConfig/components/VendorWorkspace.vue",
    ),
    "utf8",
  );
  expect(workspace).not.toContain(':type="input.type"');
  // 模板按 orderedInputs 单次循环渲染，仅一处 type 绑定。
  expect(
    workspace.match(/:type="getVisibleInputType\(input\.type\)"/g),
  ).toHaveLength(1);
});

it("idle 不得显示加载供应商设置失败", () => {
  const workspace = readFileSync(
    path.join(
      process.cwd(),
      "src/components/setting/components/vendorConfig/components/VendorWorkspace.vue",
    ),
    "utf8",
  );
  expect(workspace).toContain("selectVendorFirst");
  // 失败文案仅绑定 error 分支。
  const errorBlock = workspace.slice(
    workspace.indexOf("vendorLoadState.state === 'error'"),
    workspace.indexOf("vendorLoadState.state === 'loading'"),
  );
  expect(errorBlock).toContain("loadInputsFailed");
  const afterLoading = workspace.slice(workspace.indexOf("vendorLoadState.state === 'loading'"));
  expect(afterLoading).toContain("selectVendorFirst");
  expect(afterLoading).not.toMatch(/v-else[^>]*loadInputsFailed/);
});

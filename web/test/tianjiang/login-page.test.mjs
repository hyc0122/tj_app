import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  closeSfcHarness,
  installDom,
  loadModule,
} from "./vue-sfc-harness.mjs";

let cleanupDom;

before(async () => {
  cleanupDom = installDom();
});

after(async () => {
  await closeSfcHarness();
  cleanupDom?.();
});

test("客户端中央 API 固定且不暴露本机地址覆盖接口", async () => {
  localStorage.setItem("tianjiang.centralServerUrl", "https://attacker.invalid");
  const authClient = await loadModule("/src/features/tianjiang/auth/client.ts");

  assert.equal(authClient.CENTRAL_API_URL, "https://api.j11.com.cn");
  assert.equal("getCentralServerUrl" in authClient, false);
  assert.equal("setCentralServerUrl" in authClient, false);
  assert.equal("normalizeCentralServerUrl" in authClient, false);
});

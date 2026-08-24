/**
 * Task 9 RED：官方文档固定 URL；授权页只允许精确受信任 HTTPS 主机。
 */
import assert from "node:assert/strict";
import test from "node:test";

const OFFICIAL =
  "https://bytedance.larkoffice.com/wiki/FVTwwm0bGiishxkKOoScdHR2nsg";

test("外链策略必须固定官方文档并拒绝危险授权地址", async () => {
  const policy = await import(
    "../../src/tianjiang/model-providers/dreamina-cli/external-link-policy"
  );
  const docs = policy.resolveDreaminaExternalTarget({ kind: "official_docs" });
  assert.equal(docs.ok, true);
  assert.equal(docs.url, OFFICIAL);

  const good = policy.resolveDreaminaExternalTarget({
    kind: "authorization",
    url: "https://jimeng.jianying.com/auth?x=1",
  });
  assert.equal(good.ok, true);

  for (const url of [
    "javascript:alert(1)",
    "http://jimeng.jianying.com/auth",
    "https://user:pass@jimeng.jianying.com/auth",
    "https://evil.jianying.com.attacker/auth",
    "https://jimeng.jianying.com.evil/auth",
    "https://not-jianying.com/auth",
  ]) {
    const result = policy.resolveDreaminaExternalTarget({ kind: "authorization", url });
    assert.equal(result.ok, false, `应拒绝 ${url}`);
  }
});

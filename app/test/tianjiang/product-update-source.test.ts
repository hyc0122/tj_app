import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveUpdateSourceData,
  updateRequestSchema,
  UPDATE_SOURCES,
} from "../../src/tianjiang/update/update-manifest";
import {
  CURRENT_VENDOR_ID,
  LEGACY_VENDOR_ID,
} from "../../src/tianjiang/identity/product-identity";

test("更新清单当前键优先，缺失时只为当前来源读取旧键", () => {
  const current = [{ type: "windows", url: "current" }];
  const legacy = [{ type: "windows", url: "legacy" }];
  assert.deepEqual(
    resolveUpdateSourceData({
      [CURRENT_VENDOR_ID]: current,
      [LEGACY_VENDOR_ID]: legacy,
    }, CURRENT_VENDOR_ID),
    current,
  );
  assert.deepEqual(
    resolveUpdateSourceData({ [LEGACY_VENDOR_ID]: legacy }, CURRENT_VENDOR_ID),
    legacy,
  );
  assert.equal(resolveUpdateSourceData({ [LEGACY_VENDOR_ID]: legacy }, "github"), undefined);
});

test("旧请求来源不在允许列表且不能触发旧清单回退", () => {
  assert.equal(UPDATE_SOURCES.includes(LEGACY_VENDOR_ID as never), false);
  assert.equal(
    resolveUpdateSourceData(
      { [LEGACY_VENDOR_ID]: { version: "legacy" } },
      LEGACY_VENDOR_ID,
    ),
    undefined,
  );
  assert.equal(resolveUpdateSourceData(null, CURRENT_VENDOR_ID), undefined);
});

test("更新路由请求只接受受控来源并拒绝 renderer 自定义 URL", () => {
  assert.equal(updateRequestSchema.safeParse({ source: CURRENT_VENDOR_ID }).success, true);
  assert.equal(
    updateRequestSchema.safeParse({
      source: CURRENT_VENDOR_ID,
      url: "http://127.0.0.1/internal",
    }).success,
    false,
  );
  assert.equal(updateRequestSchema.safeParse({ source: LEGACY_VENDOR_ID }).success, false);
});

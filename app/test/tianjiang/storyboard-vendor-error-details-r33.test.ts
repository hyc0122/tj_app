/**
 * R33：普通供应商继续异步入队，但后台失败后必须保留供应商返回并交给任务中心展示。
 * 测试只构造本地错误对象，不访问任何真实供应商。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  rethrowVendorPhaseOr,
  safeVendorGenerationFailure,
  VendorGenerationPhaseError,
} from "../../src/tianjiang/storyboard/vendor-generation-safety";
import { describeStoryboardTaskCenterReason } from "../../src/tianjiang/tasks/task-center-aggregation";

test("供应商执行失败必须完整保留模型返回，不能折叠成统一文案", () => {
  const providerMessage = `视频生成请求失败：HTTP 400；错误码 InvalidParameter；${"参考素材格式不受支持。".repeat(300)}`;
  let captured: unknown;

  try {
    rethrowVendorPhaseOr("execute", new Error(providerMessage));
  } catch (error) {
    captured = error;
  }

  assert.ok(captured instanceof VendorGenerationPhaseError);
  assert.deepEqual(safeVendorGenerationFailure(captured), {
    code: "VENDOR_GENERATION_FAILED",
    message: providerMessage,
  });
});

test("任务中心必须优先返回 SQLite 中保存的完整供应商失败原因", () => {
  const providerMessage = `模型返回：${"输入内容不符合模型合同。".repeat(300)}`;
  const describeWithSummary = describeStoryboardTaskCenterReason as (
    status: string,
    errorCode: string | null,
    waitingOrigin: boolean,
    providerId: string,
    errorSummary: string | null,
  ) => string;

  assert.equal(
    describeWithSummary(
      "failed_fatal",
      "VENDOR_GENERATION_FAILED",
      false,
      "tianjiang",
      providerMessage,
    ),
    providerMessage,
  );
});

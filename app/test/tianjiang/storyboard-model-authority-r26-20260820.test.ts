/**
 * R26 RED：预览与收费提交必须共享同一条模型路由真源。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import * as generationService from "../../src/tianjiang/storyboard/storyboard-generation-service";
import {
  rethrowVendorPhaseOr,
  VendorGenerationPhaseError,
} from "../../src/tianjiang/storyboard/vendor-generation-safety";

type RouteKind = "dreamina-cli" | "vendor";
type RouteClassifier = (providerModel: string) => RouteKind;
type RouteAssertion = (input: { providerModel: string; routeKind: RouteKind }) => RouteKind;

const PROJECT = "26262626-2626-4262-8262-262626262626";
const SHOT = "26262626-ffff-4fff-8fff-ffffffffffff";

test("规范 providerModel 必须确定唯一 routeKind，路由不匹配稳定失败", () => {
  const classify = (generationService as unknown as {
    classifyStoryboardGenerationRoute?: RouteClassifier;
  }).classifyStoryboardGenerationRoute;
  const assertRoute = (generationService as unknown as {
    assertStoryboardGenerationRoute?: RouteAssertion;
  }).assertStoryboardGenerationRoute;

  assert.equal(typeof classify, "function");
  assert.equal(typeof assertRoute, "function");
  assert.equal(classify?.("dreamina-cli:seedance2.0fast"), "dreamina-cli");
  assert.equal(classify?.("volcengine:doubao-seedance-2-0-260128"), "vendor");
  assert.throws(
    () => assertRoute?.({ providerModel: "dreamina-cli:seedance2.0fast", routeKind: "vendor" }),
    (error: unknown) => {
      const row = error as { status?: unknown; code?: unknown; message?: unknown };
      return row.status === 409
        && row.code === "STORYBOARD_GENERATION_ROUTE_MISMATCH"
        && row.message === "生成路由已变化，请重新预览确认";
    },
  );
});

test("服务端预览必须回传规范 routeKind，正式路由入口必须执行一致性断言", async () => {
  const preview = await generationService.sanitizeStoryboardGenerationPreview({
    projectUuid: PROJECT,
    shotUuid: SHOT,
    mediaType: "video",
    request: {
      providerModel: "dreamina-cli:seedance2.0fast",
      prompt: "沿海码头跟拍",
      references: [],
      options: {
        aspectRatio: "9:16",
        resolution: "720p",
        durationMs: 5000,
        mode: "text2video",
      },
    },
  });
  assert.equal((preview as typeof preview & { routeKind?: unknown }).routeKind, "dreamina-cli");

  const runtimeSource = readFileSync(
    path.resolve(__dirname, "../../src/routes/tianjiang/storyboard-runtime.ts"),
    "utf8",
  );
  assert.match(runtimeSource, /assertStoryboardGenerationRoute\s*\(/);
  assert.match(runtimeSource, /routeKind\s*:/);
});

test("即梦预览不能被普通供应商模型复用为收费提交", () => {
  const common = {
    projectUuid: PROJECT,
    shotUuid: SHOT,
    mediaType: "video" as const,
  };
  const dreaminaDigest = generationService.createStoryboardGenerationPreviewDigest({
    ...common,
    request: {
      providerModel: "dreamina-cli:seedance2.0fast",
      prompt: "沿海码头跟拍",
      references: [],
      options: {
        aspectRatio: "9:16",
        resolution: "720p",
        durationMs: 5000,
        mode: "text2video",
      },
    },
  });
  const vendorDigest = generationService.createStoryboardGenerationPreviewDigest({
    ...common,
    request: {
      providerModel: "volcengine:doubao-seedance-2-0-260128",
      prompt: "沿海码头跟拍",
      references: [],
      options: {
        aspectRatio: "9:16",
        resolution: "720p",
        durationMs: 5000,
        mode: "text2video",
      },
    },
  });
  assert.notEqual(dreaminaDigest, vendorDigest);
});

test("普通供应商暂存异常只保留安全阶段码，未知步骤归一为 resolver", () => {
  assert.throws(
    () => rethrowVendorPhaseOr("stage", {
      code: "VENDOR_STAGING_OSS_PUT",
      message: "sk-secret E:\\private\\asset.png",
    }),
    (error: unknown) => error instanceof VendorGenerationPhaseError
      && error.code === "VENDOR_MEDIA_STAGING_FAILED"
      && error.stagingStep === "oss_put"
      && !error.message.includes("private"),
  );
  assert.throws(
    () => rethrowVendorPhaseOr("stage", new Error("cookie=secret SELECT * FROM files")),
    (error: unknown) => error instanceof VendorGenerationPhaseError
      && error.code === "VENDOR_MEDIA_STAGING_FAILED"
      && error.stagingStep === "resolver",
  );
});

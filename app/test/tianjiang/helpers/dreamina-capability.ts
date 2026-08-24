import crypto from "node:crypto";

import {
  DREAMINA_MODES,
  DREAMINA_VIDEO_MODELS,
  type DreaminaCapabilitySnapshot,
  type DreaminaMode,
} from "../../../src/tianjiang/model-providers/dreamina-cli/contracts";
import { writeDreaminaCapabilityCache } from "../../../src/tianjiang/model-providers/dreamina-cli/capability-cache";

const TEST_FIELDS: Record<DreaminaMode, readonly string[]> = {
  text2image: ["--prompt", "--ratio", "--resolution_type", "--model_version"],
  image2image: ["--prompt", "--images", "--ratio", "--resolution_type"],
  text2video: ["--prompt", "--duration", "--ratio", "--video_resolution", "--model_version"],
  image2video: ["--prompt", "--image", "--duration", "--video_resolution", "--model_version"],
  frames2video: ["--prompt", "--first", "--last", "--duration", "--video_resolution", "--model_version"],
  multiframe2video: ["--prompt", "--images", "--duration", "--video_resolution", "--model_version"],
  multimodal2video: [
    "--prompt",
    "--image",
    "--video",
    "--audio",
    "--duration",
    "--ratio",
    "--video_resolution",
    "--model_version",
  ],
};

/** 旧队列测试必须显式声明已探测能力，不能借 not_checked 绕过生产 fail-closed。 */
export function writeReadyDreaminaTestCapability(): void {
  const snapshot: DreaminaCapabilitySnapshot = {
    installed: true,
    version: "test-ready",
    probedAt: Date.now(),
    loggedIn: true,
    modes: Object.fromEntries(DREAMINA_MODES.map((mode) => [mode, {
      enabled: true,
      fields: TEST_FIELDS[mode],
    }])) as DreaminaCapabilitySnapshot["modes"],
    capabilities: [...DREAMINA_MODES],
    videoModels: [...DREAMINA_VIDEO_MODELS],
  };
  writeDreaminaCapabilityCache({ state: "ready", snapshot, checkedAt: Date.now() });
}

/** 旧 HTTP 测试也必须走正式 preview→confirm 协议，不能给路由留测试后门。 */
export async function withStoryboardPreviewDigest(
  generateUrl: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${generateUrl}/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as { data?: { previewDigest?: unknown }; message?: unknown };
  const digest = String(payload.data?.previewDigest ?? "");
  if (!response.ok || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`测试预览确认失败: ${String(payload.message ?? response.status)}`);
  }
  return {
    ...body,
    expectedPreviewDigest: digest,
    clientOperationId: body.clientOperationId ?? crypto.randomUUID(),
  };
}

export async function withStoryboardBatchPreviewDigests(
  generateUrl: string,
  items: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const confirmed: Record<string, unknown>[] = [];
  for (const item of items) confirmed.push(await withStoryboardPreviewDigest(generateUrl, item));
  return confirmed;
}

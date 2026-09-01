import { CanvasRuntimeError } from "../canvas/canvas-document-service";
import { CANVAS_BILLING_POLICY_VALUES, type CanvasBillingPolicy } from "../contracts";

export const CANVAS_CAPABILITY_REGISTRY_VERSION = "canvas-capability.v1";

export interface GenerationCapability {
  capabilityId: string;
  nodeType: string;
  requiresConfirmation: boolean;
  billingPolicy: CanvasBillingPolicy;
  supportedModels: readonly string[];
  parameterSchemaVersion: number;
}

const CURRENCY_MINOR_UNIT: Record<string, number> = {
  CNY: 2,
  USD: 2,
  JPY: 0,
  CLF: 4,
};

/** 中文注释：加载时校验收费能力必须确认，避免注册表把付费项直接入队。 */
export function loadGenerationCapabilityRegistry(): GenerationCapability[] {
  const capabilities: GenerationCapability[] = [
    {
      capabilityId: "canvas.image.generate",
      nodeType: "image_generation",
      requiresConfirmation: true,
      billingPolicy: "always_charge",
      supportedModels: ["account-model-catalog"],
      parameterSchemaVersion: 1,
    },
    {
      capabilityId: "canvas.video.generate",
      nodeType: "video_generation",
      requiresConfirmation: true,
      billingPolicy: "potential_charge",
      supportedModels: ["account-model-catalog"],
      parameterSchemaVersion: 1,
    },
    {
      capabilityId: "canvas.audio.generate",
      nodeType: "audio",
      requiresConfirmation: true,
      billingPolicy: "always_charge",
      supportedModels: ["account-model-catalog"],
      parameterSchemaVersion: 1,
    },
  ];
  assertCapabilityRegistry(capabilities);
  return capabilities;
}

export function assertCapabilityRegistry(capabilities: GenerationCapability[]): void {
  const seen = new Set<string>();
  for (const item of capabilities) {
    if (seen.has(item.capabilityId)) {
      throw new CanvasRuntimeError("CANVAS_EXECUTION_CAPABILITY_INVALID", "能力注册表存在重复 ID", 503, false);
    }
    seen.add(item.capabilityId);
    if (!CANVAS_BILLING_POLICY_VALUES.includes(item.billingPolicy)) {
      throw new CanvasRuntimeError("CANVAS_EXECUTION_CAPABILITY_INVALID", "未知计费策略", 503, false);
    }
    if (item.billingPolicy !== "none" && item.requiresConfirmation !== true) {
      throw new CanvasRuntimeError("CANVAS_EXECUTION_CAPABILITY_INVALID", "收费能力必须确认后执行", 503, false);
    }
    if (item.supportedModels.length === 0) {
      throw new CanvasRuntimeError("CANVAS_EXECUTION_CAPABILITY_INVALID", "能力未声明可用模型", 503, false);
    }
  }
}

export function capabilityForNodeType(nodeType: string): GenerationCapability {
  const found = loadGenerationCapabilityRegistry().find((item) => item.nodeType === nodeType);
  if (!found) {
    throw new CanvasRuntimeError("CANVAS_EXECUTION_CAPABILITY_INVALID", "未知生成能力", 503, false);
  }
  return found;
}

export function currencyMinorUnit(currency: string): number {
  const unit = CURRENCY_MINOR_UNIT[currency];
  if (unit === undefined) {
    throw new CanvasRuntimeError("CANVAS_EXECUTION_CAPABILITY_INVALID", "币种不在允许表中", 503, false);
  }
  return unit;
}

export function assertAmountMinor(value: string): void {
  if (!/^(0|[1-9][0-9]{0,17})$/.test(value)) {
    throw new CanvasRuntimeError("CANVAS_EXECUTION_CAPABILITY_INVALID", "金额必须是规范非负整数串", 503, false);
  }
}

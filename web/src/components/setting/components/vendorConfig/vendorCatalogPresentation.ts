import { modelProviderRules, providersLogo } from "@/utils/providersLogo";
import type { VendorInput } from "./types";

// 供应商字段的展示规则不依赖目录加载、密钥会话或自动保存生命周期。
export function getInputIcon(type: VendorInput["type"]) {
  if (type === "password") return "secured";
  if (type === "url") return "link";
  return "edit-1";
}

export function getInputPlaceholder(input: VendorInput) {
  return input.placeholder?.trim() || "";
}

export function getVisibleInputType(type: VendorInput["type"]): "text" | "url" {
  // 已确认产品要求：当前账号设置页直接显示本人密钥，不使用 password 掩码。
  return type === "url" ? "url" : "text";
}

export function getModelLogo(modelName: string): string | null {
  const rule = modelProviderRules.find((item) => item.pattern.test(modelName));
  return rule ? providersLogo[rule.provider] : null;
}

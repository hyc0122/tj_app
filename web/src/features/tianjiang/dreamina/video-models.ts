export interface DreaminaVideoModelOption {
  value: string;
  label: string;
}

// 中文注释：模型服务与分镜工作台必须消费同一份有序产品清单，避免探测失败后两处展示不一致。
export const DREAMINA_VIDEO_MODELS = [
  "seedance2.0",
  "seedance2.0fast",
  "seedance2.0mini",
  "seedance2.0_vip",
  "seedance2.0fast_vip",
] as const;

export const DREAMINA_VIDEO_MODEL_OPTIONS: readonly DreaminaVideoModelOption[] = DREAMINA_VIDEO_MODELS.map((model) => ({
  value: `dreamina-cli:${model}`,
  label: model,
}));

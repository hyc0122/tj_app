/**
 * 冻结的 Agent/通用 AI 部署键注册表。
 * 运行时消费、数据库种子、Agent 配置 UI、解析器必须使用同一集合。
 * 新增部署键时：先登记到本表，再写种子与 UI，否则契约测试失败。
 */

/** 简易模式下的顶层部署键（UI 主列表） */
export const SIMPLE_DEPLOYMENT_KEYS = [
  "scriptAgent",
  "productionAgent",
  "universalAi",
  "ttsDubbing",
] as const;

/** 高级模式下的子 Agent 部署键 */
export const ADVANCED_DEPLOYMENT_KEYS = [
  "scriptAgent:decisionAgent",
  "scriptAgent:supervisionAgent",
  "scriptAgent:storySkeletonAgent",
  "scriptAgent:adaptationStrategyAgent",
  "scriptAgent:scriptAgent",
  "productionAgent:decisionAgent",
  "productionAgent:supervisionAgent",
  "productionAgent:deriveAssetsAgent",
  "productionAgent:generateAssetsAgent",
  "productionAgent:directorPlanAgent",
  "productionAgent:storyboardGenAgent",
  "productionAgent:storyboardPanelAgent",
  "productionAgent:storyboardTableAgent",
] as const;

/** 全部已登记部署键（含简易顶层 + 高级子键） */
export const FROZEN_DEPLOYMENT_KEYS = [
  ...SIMPLE_DEPLOYMENT_KEYS,
  ...ADVANCED_DEPLOYMENT_KEYS,
] as const;

export type SimpleDeploymentKey = (typeof SIMPLE_DEPLOYMENT_KEYS)[number];
export type AdvancedDeploymentKey = (typeof ADVANCED_DEPLOYMENT_KEYS)[number];
export type FrozenDeploymentKey = (typeof FROZEN_DEPLOYMENT_KEYS)[number];

const DEPLOY_KEY_SET = new Set<string>(FROZEN_DEPLOYMENT_KEYS);

/** 是否为注册表中的正式部署键（非 `vendorId:modelName` 直连键） */
export function isFrozenDeploymentKey(value: string): value is FrozenDeploymentKey {
  return DEPLOY_KEY_SET.has(value);
}

/**
 * 简易模式回退用的父键：`scriptAgent:decisionAgent` → `scriptAgent`。
 * 顶层键自身原样返回。
 */
export function parentDeploymentKey(key: string): string {
  const [mainly] = key.split(/:(.+)/);
  return mainly || key;
}

/**
 * 运行时消费链登记（文档化 + 契约测试对照）。
 * 新增 Ai.Text/Image/Video 部署键调用时必须同步更新本表与 FROZEN_DEPLOYMENT_KEYS。
 */
export const RUNTIME_DEPLOYMENT_CONSUMERS: ReadonlyArray<{
  key: FrozenDeploymentKey | "scriptAgent" | "productionAgent";
  consumers: readonly string[];
}> = [
  {
    key: "universalAi",
    consumers: [
      "utils/cleanNovel.ts#eventExtraction",
      "routes/artStyle/extractStylePrompt.ts",
      "routes/assetsGenerate/polishAssetsPrompt.ts",
      "routes/assetsGenerate/batchPolishAssetsPrompt.ts",
      "routes/script/extractAssets.ts",
      "routes/script/getAiRegex.ts",
      "routes/production/workbench/generateVideoPrompt.ts",
      "routes/production/workbench/batchGeneratePrompt.ts",
      "routes/production/assets/batchGenerateAssetsImage.ts",
      "routes/cornerScape/batchBindAudio.ts",
      "tianjiang/canvas/canvas-chat-service.ts#runHomePlan",
      "tianjiang/canvas/canvas-chat-service.ts#runCanvasChat",
    ],
  },
  {
    key: "scriptAgent",
    consumers: ["agents/scriptAgent/*", "utils/agent/memory.ts#scriptAgent"],
  },
  {
    key: "productionAgent",
    consumers: ["agents/productionAgent/*", "utils/agent/memory.ts#productionAgent"],
  },
  {
    key: "scriptAgent:decisionAgent",
    consumers: ["agents/scriptAgent/index.ts#decision"],
  },
  {
    key: "scriptAgent:supervisionAgent",
    consumers: ["agents/scriptAgent/index.ts#supervision"],
  },
  {
    key: "scriptAgent:storySkeletonAgent",
    consumers: ["agents/scriptAgent/index.ts#storySkeleton"],
  },
  {
    key: "scriptAgent:adaptationStrategyAgent",
    consumers: ["agents/scriptAgent/index.ts#adaptationStrategy"],
  },
  {
    key: "scriptAgent:scriptAgent",
    consumers: ["agents/scriptAgent/index.ts#script"],
  },
  {
    key: "productionAgent:decisionAgent",
    consumers: ["agents/productionAgent/index.ts#decision"],
  },
  {
    key: "productionAgent:supervisionAgent",
    consumers: ["agents/productionAgent/index.ts#supervision"],
  },
  {
    key: "productionAgent:deriveAssetsAgent",
    consumers: ["agents/productionAgent/index.ts#deriveAssets"],
  },
  {
    key: "productionAgent:generateAssetsAgent",
    consumers: ["agents/productionAgent/index.ts#generateAssets"],
  },
  {
    key: "productionAgent:directorPlanAgent",
    consumers: ["agents/productionAgent/index.ts#directorPlan"],
  },
  {
    key: "productionAgent:storyboardGenAgent",
    consumers: ["agents/productionAgent/index.ts#storyboardGen"],
  },
  {
    key: "productionAgent:storyboardPanelAgent",
    consumers: ["agents/productionAgent/index.ts#storyboardPanel"],
  },
  {
    key: "productionAgent:storyboardTableAgent",
    consumers: ["agents/productionAgent/index.ts#storyboardTable"],
  },
  {
    key: "ttsDubbing",
    consumers: ["(reserved) TTS 配音；当前种子 disabled"],
  },
];

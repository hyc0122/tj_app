/**
 * 统一账号级模型/配置解析器。
 * 所有 AI 部署键、供应商、私有输入、Agent 设置与自定义 Prompt 必须经此模块读账号 db2，
 * 禁止在各业务路由上复制「找不到再查 db2」补丁。
 * 业务数据（任务/小说/事件/资产/记忆正文）仍走项目库 u.db。
 */
import type { Knex } from "knex";
import type { o_agentDeploy } from "@/types/database";
import { accountDatabase } from "@/utils/db";
import {
  isFrozenDeploymentKey,
  parentDeploymentKey,
  type FrozenDeploymentKey,
} from "@/tianjiang/model/deployment-keys";
import {
  mergeVendorModelList,
  parseVendorModelsState,
} from "@/utils/vendor-models-store";
import { loadVendorPrivateInputs } from "@/utils/vendor-private-config";

export type DeployKeyOrModelRef = FrozenDeploymentKey | `${string}:${string}` | string;

/** 用户可见错误：不含密钥、绝对路径、SQL、堆栈 */
function safeConfigError(message: string): Error {
  return new Error(message);
}

/** 当前账号库 knex（显式；测试可注入） */
export function getAccountKnex(database?: Knex): Knex {
  return database ?? accountDatabase();
}

/**
 * 读取账号级 o_setting 单值。
 * 项目 ALS 下仍读账号库，项目库同名行不得覆盖。
 */
export async function getAccountSetting(
  key: string,
  database?: Knex,
): Promise<string | null> {
  const db = getAccountKnex(database);
  const row = await db("o_setting").where("key", key).first();
  if (!row || row.value == null) return null;
  return String(row.value);
}

/**
 * 批量读取账号级 o_setting。
 */
export async function getAccountSettings(
  keys: string[],
  database?: Knex,
): Promise<Record<string, string | null>> {
  const db = getAccountKnex(database);
  const rows = await db("o_setting").whereIn("key", keys);
  const map: Record<string, string | null> = {};
  for (const key of keys) map[key] = null;
  for (const row of rows) {
    if (row.key != null) map[row.key] = row.value == null ? null : String(row.value);
  }
  return map;
}

/**
 * 读取账号级自定义 Prompt（o_prompt）。
 * useData 优先于 data。
 */
export async function getAccountPrompt(
  type: string,
  database?: Knex,
): Promise<{ data?: string | null; useData?: string | null } | null> {
  const db = getAccountKnex(database);
  const row = await db("o_prompt").where("type", type).first();
  if (!row) return null;
  return {
    data: row.data ?? null,
    useData: row.useData ?? null,
  };
}

/** 解析后生效的 Prompt 正文 */
export async function resolveAccountPromptText(
  type: string,
  database?: Knex,
): Promise<string | undefined> {
  const row = await getAccountPrompt(type, database);
  if (!row) return undefined;
  if (row.useData) return String(row.useData);
  if (row.data) return String(row.data);
  return undefined;
}

/**
 * 从账号库读取 o_agentDeploy 行（不应用简易/高级回退）。
 */
export async function getAccountAgentDeployRow(
  key: string,
  database?: Knex,
): Promise<o_agentDeploy | undefined> {
  const db = getAccountKnex(database);
  return (await db("o_agentDeploy").where("key", key).first()) as o_agentDeploy | undefined;
}

/**
 * 统一解析部署键 → `vendorId:modelName`。
 * agentUseMode 与 o_agentDeploy 一律来自账号库；项目库同键即使有陈旧配置也不得覆盖。
 */
export async function resolveAccountDeployModelName(
  value: DeployKeyOrModelRef,
  database?: Knex,
): Promise<`${string}:${string}`> {
  // 非注册部署键：视为直连 vendorId:modelName
  if (!isFrozenDeploymentKey(String(value))) {
    return value as `${string}:${string}`;
  }

  const key = String(value);
  const agentUseMode = await getAccountSetting("agentUseMode", database);

  // 高级模式：精确键
  if (agentUseMode === "1") {
    const row = await getAccountAgentDeployRow(key, database);
    if (!row?.modelName) {
      throw safeConfigError(`高级配置模式下，未找到对应的模型配置 ${key}`);
    }
    return row.modelName as `${string}:${string}`;
  }

  // 简易模式：父键
  if (agentUseMode === "0") {
    const parent = parentDeploymentKey(key);
    const row = await getAccountAgentDeployRow(parent, database);
    if (!row?.modelName) {
      throw safeConfigError(`简易配置模式下，未找到部署配置 ${parent}`);
    }
    return row.modelName as `${string}:${string}`;
  }

  // 未配置 agentUseMode：先精确键，再父键（兼容旧数据）
  const exact = await getAccountAgentDeployRow(key, database);
  if (exact?.modelName) {
    return exact.modelName as `${string}:${string}`;
  }
  const parent = parentDeploymentKey(key);
  const parentRow = await getAccountAgentDeployRow(parent, database);
  if (!parentRow?.modelName) {
    throw safeConfigError(`未找到部署配置 ${key}`);
  }
  return parentRow.modelName as `${string}:${string}`;
}

/**
 * 解析部署配置行（温度/maxTokens 等），来源同 resolveAccountDeployModelName。
 */
export async function resolveAccountDeployConfig(
  value: DeployKeyOrModelRef,
  database?: Knex,
): Promise<o_agentDeploy | null> {
  if (!isFrozenDeploymentKey(String(value))) {
    return null;
  }
  const key = String(value);
  const agentUseMode = await getAccountSetting("agentUseMode", database);

  if (agentUseMode === "1") {
    const row = await getAccountAgentDeployRow(key, database);
    if (!row?.modelName) {
      throw safeConfigError(`高级配置模式下，未找到对应的模型配置 ${key}`);
    }
    return row;
  }
  if (agentUseMode === "0") {
    const parent = parentDeploymentKey(key);
    const row = await getAccountAgentDeployRow(parent, database);
    if (!row?.modelName) {
      throw safeConfigError(`简易配置模式下，未找到部署配置 ${parent}`);
    }
    return row;
  }

  const exact = await getAccountAgentDeployRow(key, database);
  if (exact?.modelName) return exact;
  const parent = parentDeploymentKey(key);
  const parentRow = await getAccountAgentDeployRow(parent, database);
  if (!parentRow?.modelName) {
    throw safeConfigError(`未找到部署配置 ${key}`);
  }
  return parentRow;
}

/**
 * 账号库供应商行（不含密钥回显逻辑，仅结构）。
 */
export async function getAccountVendorConfig(
  vendorId: string,
  database?: Knex,
): Promise<Record<string, unknown> | undefined> {
  const db = getAccountKnex(database);
  return (await db("o_vendorConfig").where("id", vendorId).first()) as
    | Record<string, unknown>
    | undefined;
}

/**
 * 账号库模型列表：o_vendorConfig.models + 模板合并。
 * 动态导入 vendor 工具，避免与 utils 桶循环依赖。
 */
export async function getAccountVendorModelList(
  vendorId: string,
  database?: Knex,
  options: { templateNetworkPolicy?: "enabled" | "blocked" } = {},
): Promise<Array<Record<string, unknown>>> {
  const db = getAccountKnex(database);
  const models = await db("o_vendorConfig").where("id", vendorId).select("models").first();
  if (!models) return [];
  const { getTemplateModels } = await import("@/utils/vendor");
  const templateModels = getTemplateModels(vendorId, {
    networkPolicy: options.templateNetworkPolicy ?? "enabled",
  });
  const state = parseVendorModelsState((models as { models?: string | null }).models);
  if (templateModels.length === 0 && state.custom.length === 0) return [];
  return mergeVendorModelList(templateModels, state) as Array<Record<string, unknown>>;
}

/**
 * 账号库私有输入（密钥仅在此路径注入供应商 VM，不写响应）。
 */
export async function loadAccountVendorPrivateInputs(
  vendorId: string,
  database?: Knex,
): Promise<Record<string, string>> {
  return loadVendorPrivateInputs(vendorId, getAccountKnex(database));
}

/**
 * 组装供应商请求函数所需的账号侧元数据。
 * 项目库中的同 id 供应商行即使存在也不得参与。
 */
export async function resolveAccountVendorRuntime(
  modelName: `${string}:${string}`,
  database?: Knex,
  options: { templateNetworkPolicy?: "enabled" | "blocked" } = {},
): Promise<{
  vendorId: string;
  modelId: string;
  vendorConfig: Record<string, unknown>;
  selectedModel: Record<string, unknown>;
  modelList: Array<Record<string, unknown>>;
  privateInputs: Record<string, string>;
}> {
  const [vendorId, modelId] = modelName.split(/:(.+)/);
  if (!vendorId || !modelId) {
    throw safeConfigError("模型引用格式无效");
  }
  const vendorConfig = await getAccountVendorConfig(vendorId, database);
  if (!vendorConfig) {
    throw safeConfigError(`未找到供应商配置`);
  }
  const modelList = await getAccountVendorModelList(vendorId, database, options);
  const selectedModel = modelList.find((item) => item.modelName === modelId);
  if (!selectedModel) {
    throw safeConfigError(`未找到模型`);
  }
  const privateInputs = await loadAccountVendorPrivateInputs(vendorId, database);
  return {
    vendorId,
    modelId,
    vendorConfig,
    selectedModel,
    modelList,
    privateInputs,
  };
}

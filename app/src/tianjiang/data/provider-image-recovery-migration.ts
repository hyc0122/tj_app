import type { Knex } from "knex";

const JIASU_PROVIDER_ID = "tianjiang";
const VOLCENGINE_PROVIDER_ID = "volcengine";

interface ProviderRecoveryDependencies {
  builtinSources: Record<string, string>;
  readInstalledVersion(providerId: string): string | undefined;
  writeInstalledSource(providerId: string, source: string): void;
}

interface StoredModel {
  name?: unknown;
  modelName?: unknown;
  type?: unknown;
  [key: string]: unknown;
}

function versionParts(value: string | undefined): number[] {
  return String(value ?? "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => Number.isFinite(part) ? part : 0);
}

function versionLessThan(value: string | undefined, minimum: string): boolean {
  const current = versionParts(value);
  const target = versionParts(minimum);
  const length = Math.max(current.length, target.length);
  for (let index = 0; index < length; index += 1) {
    const left = current[index] ?? 0;
    const right = target[index] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

function parseStoredModels(value: unknown): StoredModel[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(parsed)) throw new Error("models 不是数组");
    return parsed as StoredModel[];
  } catch (error) {
    throw new Error(
      `佳速 API 模型配置损坏，无法安全升级：${error instanceof Error ? error.message : "未知错误"}`,
    );
  }
}

function upgradeJiasuPreset(model: StoredModel): StoredModel {
  if (model.modelName === "doubao-seedream-5.0-Lite" && model.type === "image") {
    return {
      ...model,
      name: "Doubao Seedream 4.0",
      modelName: "doubao-seedream-4-0-250828",
      mode: ["text", "singleImage", "multiReference"],
    };
  }
  if (model.modelName === "Seedance 2.0" && model.type === "video") {
    return {
      ...model,
      name: "Doubao Seedance 1.0 Pro Fast",
      modelName: "doubao-seedance-1-0-pro-fast",
      mode: ["text", "singleImage"],
      audio: false,
      durationResolutionMap: [{
        duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        resolution: ["480p", "720p", "1080p"],
      }],
    };
  }
  return model;
}

function maybeInstallSource(
  providerId: string,
  minimumVersion: string,
  dependencies: ProviderRecoveryDependencies,
): void {
  if (!versionLessThan(dependencies.readInstalledVersion(providerId), minimumVersion)) return;
  const source = dependencies.builtinSources[providerId];
  if (!source) throw new Error(`缺少内置供应商源码：${providerId}`);
  dependencies.writeInstalledSource(providerId, source);
}

/**
 * 升级已安装供应商源码，并只替换已确认错误的佳速预置模型。
 * API Key、Base URL、自定义模型和既有启用状态都保持不变。
 */
export async function migrateProviderImageRecovery(
  database: Knex | Knex.Transaction,
  dependencies: ProviderRecoveryDependencies,
): Promise<void> {
  const jiasuRow = await database("o_vendorConfig").where({ id: JIASU_PROVIDER_ID }).first();
  if (jiasuRow) {
    const models = parseStoredModels(jiasuRow.models);
    const upgraded = models.map(upgradeJiasuPreset);
    if (JSON.stringify(upgraded) !== JSON.stringify(models)) {
      await database("o_vendorConfig")
        .where({ id: JIASU_PROVIDER_ID })
        .update({ models: JSON.stringify(upgraded) });
    }
    // 4.2 起图片统一改走 /images/create，确保已安装的佳速配置也同步升级动态源码。
    maybeInstallSource(JIASU_PROVIDER_ID, "4.2", dependencies);
  }

  const volcengineRow = await database("o_vendorConfig")
    .where({ id: VOLCENGINE_PROVIDER_ID })
    .first();
  if (volcengineRow) {
    // 火山只更新动态源码，账号密钥、Coding 文本地址和用户模型均不改写。
    maybeInstallSource(VOLCENGINE_PROVIDER_ID, "2.5", dependencies);
  }
}

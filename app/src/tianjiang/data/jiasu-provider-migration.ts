import type { Knex } from "knex";

const JIASU_BASE_URL = "https://js.jiasuapi.com/v1";
const MINIMUM_TEMPLATE_VERSION = [4, 0];
const MODEL_CATALOG_TEMPLATE_VERSION = [4, 4];

interface VendorConfigRow {
  id: string;
  inputValues?: string | null;
}

export interface JiasuProviderMigrationDependencies {
  builtinSource: string;
  readInstalledVersion(): string | undefined;
  writeInstalledSource(source: string): void;
}

function parseInputValues(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    // 账号级密钥在该字段中；损坏时必须阻断，禁止用空对象覆盖用户配置。
    throw new Error("佳速 API 配置损坏，无法安全迁移供应商配置");
  }
}

function isVersionAtLeast(value: string | undefined, minimum: number[]): boolean {
  if (!value) return false;
  const parts = value.trim().split(".").map((part) => Number(part));
  if (parts.length === 0 || parts.some((part) => !Number.isSafeInteger(part) || part < 0)) return false;
  const length = Math.max(parts.length, minimum.length);
  for (let index = 0; index < length; index += 1) {
    const actual = parts[index] ?? 0;
    const expected = minimum[index] ?? 0;
    if (actual > expected) return true;
    if (actual < expected) return false;
  }
  return true;
}

/**
 * 把已安装的 Tianjiang 内置供应商切换到佳速 API v4。
 * 仅更新隐藏基地址与内置源码，密钥、用户扩展字段、模型和启用状态均保持不变。
 */
export async function migrateJiasuProviderV4(
  database: Knex | Knex.Transaction,
  dependencies: JiasuProviderMigrationDependencies,
): Promise<void> {
  if (!(await database.schema.hasTable("o_vendorConfig"))) return;
  const row = await database<VendorConfigRow>("o_vendorConfig")
    .where({ id: "tianjiang" })
    .first();
  if (!row) return;

  const inputValues = parseInputValues(row.inputValues);
  const installedVersion = dependencies.readInstalledVersion();
  if (!isVersionAtLeast(installedVersion, MINIMUM_TEMPLATE_VERSION)) {
    if (!dependencies.builtinSource.trim()) throw new Error("佳速 API 内置模板缺失");
    dependencies.writeInstalledSource(dependencies.builtinSource);
  }

  await database<VendorConfigRow>("o_vendorConfig")
    .where({ id: "tianjiang" })
    .update({
      inputValues: JSON.stringify({
        ...inputValues,
        baseUrl: JIASU_BASE_URL,
      }),
    });
}

/**
 * 把已安装的旧佳速动态源码升级到 4.4，使现有账号获得远端模型列表能力。
 * 该迁移只替换内置供应商源码，不修改密钥、模型、启用状态或其他账号配置。
 */
export async function migrateJiasuProviderModelCatalogV44(
  database: Knex | Knex.Transaction,
  dependencies: JiasuProviderMigrationDependencies,
): Promise<void> {
  if (!(await database.schema.hasTable("o_vendorConfig"))) return;
  const row = await database<VendorConfigRow>("o_vendorConfig")
    .where({ id: "tianjiang" })
    .first();
  if (!row || isVersionAtLeast(
    dependencies.readInstalledVersion(),
    MODEL_CATALOG_TEMPLATE_VERSION,
  )) return;
  if (!dependencies.builtinSource.trim()) throw new Error("佳速 API 4.4 内置模板缺失");
  dependencies.writeInstalledSource(dependencies.builtinSource);
}

/**
 * 中文注释：独立账号迁移让已安装 4.4 的用户升级异步协议，不重跑历史迁移。
 * 只改旧官方基地址和动态源码，不写 models、enable、o_agentDeploy 或其他模型映射。
 */
export async function migrateJiasuProviderAsyncV5(
  database: Knex | Knex.Transaction,
  dependencies: JiasuProviderMigrationDependencies,
): Promise<void> {
  if (!(await database.schema.hasTable("o_vendorConfig"))) return;
  const row = await database<VendorConfigRow>("o_vendorConfig").where({ id: "tianjiang" }).first();
  if (!row) return;
  const inputs = parseInputValues(row.inputValues);
  const baseUrl = typeof inputs.baseUrl === "string" ? inputs.baseUrl.trim().replace(/\/+$/, "") : "";
  const needsBaseUrl = !baseUrl || /^https:\/\/js\.jiasuapi\.com(?:\/v1)?$/i.test(baseUrl);
  if (!isVersionAtLeast(dependencies.readInstalledVersion(), [5, 0])) {
    if (!dependencies.builtinSource.trim()) throw new Error("佳速 API 5.0 内置模板缺失");
    // 源码写入失败时不动数据库；事务回滚后重跑也不会反向降级已写入的新源码。
    dependencies.writeInstalledSource(dependencies.builtinSource);
  }
  if (needsBaseUrl) {
    await database<VendorConfigRow>("o_vendorConfig").where({ id: "tianjiang" }).update({
      inputValues: JSON.stringify({ ...inputs, baseUrl: "https://ai.jiasuapi.com/v1" }),
    });
  }
}

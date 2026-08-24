import type { Knex } from "knex";
import fs from "node:fs";
import path from "node:path";

import {
  CURRENT_VENDOR_ID,
  LEGACY_VENDOR_ID,
} from "../identity/product-identity";
import {
  parseVendorModelsState,
  serializeVendorModelsState,
  type VendorModelRecord,
} from "../../utils/vendor-models-store";

interface VendorRow {
  id: string;
  inputValues?: string | null;
  models?: string | null;
  enable?: number | null;
}

/**
 * 将旧供应商主键及其引用单向归并到当前机器标识。
 * 新行优先，旧行只补充尚未设置的私密字段与模型，避免覆盖用户的新配置。
 */
export async function migrateLegacyVendorIdentity(
  database: Knex | Knex.Transaction,
): Promise<void> {
  if (!(await database.schema.hasTable("o_vendorConfig"))) return;
  const legacy = await database<VendorRow>("o_vendorConfig")
    .where("id", LEGACY_VENDOR_ID)
    .first();
  if (!legacy) {
    const current = await database<VendorRow>("o_vendorConfig")
      .where("id", CURRENT_VENDOR_ID)
      .first();
    if (current) {
      await database<VendorRow>("o_vendorConfig")
        .where("id", CURRENT_VENDOR_ID)
        .update({
          models: replaceLegacyMachineIdentifier(current.models),
        });
    }
    await migrateVendorReferences(database);
    return;
  }

  const current = await database<VendorRow>("o_vendorConfig")
    .where("id", CURRENT_VENDOR_ID)
    .first();
  if (!current) {
    await database<VendorRow>("o_vendorConfig")
      .where("id", LEGACY_VENDOR_ID)
      .update({
        id: CURRENT_VENDOR_ID,
        models: replaceLegacyMachineIdentifier(legacy.models),
      });
  } else {
    const legacyInputs = parseObject(legacy.inputValues, "旧供应商配置");
    const currentInputs = parseObject(current.inputValues, "当前供应商配置");
    // 兼容旧数组与 { custom, excluded } 新存储；损坏 JSON 失败关闭不删行。
    const legacyState = parseVendorModelsState(legacy.models, {
      strict: true,
      label: "旧供应商模型",
    });
    const currentState = parseVendorModelsState(current.models, {
      strict: true,
      label: "当前供应商模型",
    });
    const mergedCustom = mergeModelDefinitions(
      currentState.custom,
      legacyState.custom,
    ) as VendorModelRecord[];
    const mergedExcluded = [
      ...new Set([...currentState.excluded, ...legacyState.excluded]),
    ];
    await database<VendorRow>("o_vendorConfig")
      .where("id", CURRENT_VENDOR_ID)
      .update({
        inputValues: JSON.stringify({ ...legacyInputs, ...currentInputs }),
        models: serializeVendorModelsState({
          custom: mergedCustom,
          excluded: mergedExcluded,
        }),
        enable: Number(Boolean(current.enable) || Boolean(legacy.enable)),
      });
    await database<VendorRow>("o_vendorConfig").where("id", LEGACY_VENDOR_ID).delete();
  }

  await migrateVendorReferences(database);
}

/**
 * 将旧动态供应商文件迁入当前文件名；冲突内容先进入恢复区，再移除运行目录中的旧文件。
 */
export function migrateLegacyVendorSourceFile(vendorRoot: string): void {
  const legacyPath = path.join(vendorRoot, `${LEGACY_VENDOR_ID}.ts`);
  const currentPath = path.join(vendorRoot, `${CURRENT_VENDOR_ID}.ts`);
  if (!fs.existsSync(legacyPath)) {
    normalizeCurrentVendorSourceFile(currentPath);
    return;
  }
  fs.mkdirSync(vendorRoot, { recursive: true });
  const legacySource = fs.readFileSync(legacyPath, "utf8");
  const migratedSource = replaceLegacyMachineIdentifier(legacySource);
  if (fs.existsSync(currentPath)) {
    const originalCurrentSource = fs.readFileSync(currentPath, "utf8");
    const currentSource = replaceLegacyMachineIdentifier(originalCurrentSource);
    if (currentSource !== originalCurrentSource) {
      writeVendorSourceAtomically(currentPath, currentSource);
    }
    if (currentSource !== migratedSource) {
      const recoveryRoot = path.join(vendorRoot, "legacy-identity-recovery");
      fs.mkdirSync(recoveryRoot, { recursive: true });
      fs.copyFileSync(
        legacyPath,
        path.join(recoveryRoot, `${LEGACY_VENDOR_ID}.${Date.now()}.ts`),
        fs.constants.COPYFILE_EXCL,
      );
    }
    fs.rmSync(legacyPath);
    return;
  }
  writeVendorSourceAtomically(currentPath, migratedSource);
  fs.rmSync(legacyPath);
}

function normalizeCurrentVendorSourceFile(currentPath: string): void {
  if (!fs.existsSync(currentPath)) return;
  const source = fs.readFileSync(currentPath, "utf8");
  const normalizedSource = replaceLegacyMachineIdentifier(source);
  if (source === normalizedSource) return;
  writeVendorSourceAtomically(currentPath, normalizedSource);
}

function writeVendorSourceAtomically(targetPath: string, source: string): void {
  const temporaryPath =
    `${targetPath}.${process.pid}.${Date.now()}.identity-migration.tmp`;
  fs.writeFileSync(temporaryPath, source, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

async function migrateVendorReferences(
  database: Knex | Knex.Transaction,
): Promise<void> {
  await updateExactIdentifier(database, "o_agentDeploy", "vendorId");
  await updatePrefixedIdentifier(database, "o_agentDeploy", "model");
  await updatePrefixedIdentifier(database, "o_agentDeploy", "modelName");
  await updateExactIdentifier(database, "o_modelPrompt", "vendorId");
  await updatePrefixedIdentifier(database, "o_modelPrompt", "model");
  await updateExactIdentifier(database, "o_tasks", "provider");
}

async function updateExactIdentifier(
  database: Knex | Knex.Transaction,
  table: string,
  column: string,
): Promise<void> {
  if (!(await database.schema.hasTable(table))) return;
  if (!(await database.schema.hasColumn(table, column))) return;
  await database(table).where(column, LEGACY_VENDOR_ID).update({
    [column]: CURRENT_VENDOR_ID,
  });
}

async function updatePrefixedIdentifier(
  database: Knex | Knex.Transaction,
  table: string,
  column: string,
): Promise<void> {
  if (!(await database.schema.hasTable(table))) return;
  if (!(await database.schema.hasColumn(table, column))) return;
  const legacyPrefix = `${LEGACY_VENDOR_ID}:`;
  const currentPrefix = `${CURRENT_VENDOR_ID}:`;
  await database(table)
    .where(column, "like", `${legacyPrefix}%`)
    .update({
      [column]: database.raw("replace(??, ?, ?)", [
        column,
        legacyPrefix,
        currentPrefix,
      ]),
    });
}

function replaceLegacyMachineIdentifier(value: string | null | undefined): string {
  return String(value ?? "").replaceAll(LEGACY_VENDOR_ID, CURRENT_VENDOR_ID);
}

function replaceLegacyMachineIdentifierDeep(value: unknown): unknown {
  if (typeof value === "string") return replaceLegacyMachineIdentifier(value);
  if (Array.isArray(value)) return value.map(replaceLegacyMachineIdentifierDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceLegacyMachineIdentifierDeep(item),
      ]),
    );
  }
  return value;
}

function mergeModelDefinitions(currentModels: unknown[], legacyModels: unknown[]): unknown[] {
  const merged: unknown[] = [];
  const seen = new Set<string>();
  for (const model of [...currentModels, ...legacyModels]) {
    const normalized = replaceLegacyMachineIdentifierDeep(model);
    const key = modelStableKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }
  return merged;
}

function modelStableKey(model: unknown): string {
  if (model && typeof model === "object" && !Array.isArray(model)) {
    const record = model as Record<string, unknown>;
    for (const field of ["modelName", "model", "id", "name"]) {
      if (typeof record[field] === "string" && record[field].length > 0) {
        return `${field}:${record[field]}`;
      }
    }
  }
  return `json:${stableStringify(model)}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function parseObject(
  value: string | null | undefined,
  label: string,
): Record<string, unknown> {
  if (!value || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    throw new Error(`${label} JSON 损坏，已停止迁移以保护原始数据`);
  }
  throw new Error(`${label} JSON 类型无效，已停止迁移以保护原始数据`);
}

function parseArray(
  value: string | null | undefined,
  label: string,
): unknown[] {
  if (!value || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    throw new Error(`${label} JSON 损坏，已停止迁移以保护原始数据`);
  }
  throw new Error(`${label} JSON 类型无效，已停止迁移以保护原始数据`);
}

import { transform } from "sucrase";
import fs from "fs";
import { randomUUID } from "node:crypto";
import u from "@/utils";
import {
  mergeVendorModelList,
  parseVendorModelsState,
  type VendorModelRecord,
} from "@/utils/vendor-models-store";
import {
  assertSafeVendorId,
  assertSafeVendorSourceRoot,
  assertVendorSourceSize,
  resolveVendorSourceFile,
  resolveWritableVendorSourceFile,
} from "@/utils/vendor-source-path";

export function writeCode(id: string | number, tsCode: string) {
  const safeId = assertSafeVendorId(String(id));
  assertVendorSourceSize(tsCode);
  const rootDir = u.getPath("vendor");
  fs.mkdirSync(rootDir, { recursive: true });
  const targetFile = resolveWritableVendorSourceFile(rootDir, safeId);
  const operationId = `${process.pid}.${randomUUID()}`;
  const temporaryFile = `${targetFile}.${operationId}.tmp`;
  const backupFile = `${targetFile}.${operationId}.bak`;
  let backupCreated = false;
  let committed = false;
  try {
    // 先写同目录临时文件，再以重命名替换，避免直接跟随被竞态替换的符号链接。
    fs.writeFileSync(temporaryFile, tsCode, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    // 替换前再次校验；若目标被换成链接，renameSync 只移动链接本身，不跟随写入。
    resolveWritableVendorSourceFile(rootDir, safeId);
    if (fs.existsSync(targetFile)) {
      fs.renameSync(targetFile, backupFile);
      backupCreated = true;
    }
    fs.renameSync(temporaryFile, targetFile);
    committed = true;
    if (backupCreated) fs.rmSync(backupFile, { force: true });
  } catch (error) {
    // 新文件落盘失败时恢复原文件；恢复失败则保留 .bak 供人工恢复，不静默删除。
    if (
      backupCreated
      && !committed
      && !fs.existsSync(targetFile)
      && fs.existsSync(backupFile)
    ) {
      try {
        fs.renameSync(backupFile, targetFile);
      } catch {
        // 保留备份文件，原始异常继续向上抛出。
      }
    }
    throw error;
  } finally {
    fs.rmSync(temporaryFile, { force: true });
    if (committed) fs.rmSync(backupFile, { force: true });
  }
}

export function getCode(id: string): string {
  const safeId = assertSafeVendorId(id);
  const rootDir = u.getPath("vendor");
  assertSafeVendorSourceRoot(rootDir);
  const targetFile = resolveVendorSourceFile(rootDir, safeId);
  if (!fs.existsSync(targetFile)) return "";
  // 拒绝符号链接逃逸到账号目录外。
  const stat = fs.lstatSync(targetFile);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("供应商源码文件无效");
  }
  const code = fs.readFileSync(targetFile, "utf-8");
  assertVendorSourceSize(code);
  return code;
}

/** 读取供应商模板中声明的模型列表（不含用户自定义与排除）。仅读文件系统，不访问数据库。 */
export function getTemplateModels(
  id: string,
  options: { networkPolicy?: "enabled" | "blocked" } = {},
): VendorModelRecord[] {
  const code = getCode(id);
  if (!code) return [];
  const jsCode = transform(code, { transforms: ["typescript"] }).code;
  const vendorData = u.vm(jsCode, undefined, {
    provider: id,
    networkPolicy: options.networkPolicy ?? "enabled",
  });
  if (!vendorData || !vendorData.vendor || !Array.isArray(vendorData.vendor.models)) {
    return [];
  }
  return JSON.parse(JSON.stringify(vendorData.vendor.models)) as VendorModelRecord[];
}

/**
 * 用已读出的 o_vendorConfig.models 列 + 模板源码合并可见模型列表。
 * 与 getModelList 语义一致：模板 − excluded + custom，同名 custom 覆盖。
 * 不查询数据库——事务内 bulk 配置必须用此函数，禁止再走 accountDb。
 */
export function buildMergedVendorModelList(
  vendorId: string,
  modelsColumn: string | null | undefined,
  options: { networkPolicy?: "enabled" | "blocked" } = {},
): VendorModelRecord[] {
  const templateModels = getTemplateModels(vendorId, options);
  const state = parseVendorModelsState(modelsColumn);
  if (templateModels.length === 0 && state.custom.length === 0) return [];
  return mergeVendorModelList(templateModels, state);
}

export async function getModelList(id: string): Promise<Array<any>> {
  // 供应商与模型列表是账号级配置：即使处于项目 ALS 也必须读 db2，禁止读项目空白种子。
  const { accountDb } = await import("@/utils/db");
  const models = await accountDb("o_vendorConfig").where("id", id).select("models").first();
  if (!models) return [];
  return buildMergedVendorModelList(id, models.models);
}

export function getVendor(id: string) {
  const code = getCode(id);
  const jsCode = transform(code, { transforms: ["typescript"] }).code;
  const vendorData = u.vm(jsCode);
  return vendorData.vendor;
}

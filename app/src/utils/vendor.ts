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
import { loadVendorPrivateInputs } from "@/utils/vendor-private-config";

export interface RemoteVendorModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

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

export async function listRemoteModels(
  id: string,
  options: {
    source?: string;
    privateInputs?: Record<string, string>;
  } = {},
): Promise<RemoteVendorModel[]> {
  const safeId = assertSafeVendorId(id);
  const source = options.source ?? getCode(safeId);
  if (!source.trim()) throw new Error("供应商源码不存在或为空");
  const javascript = transform(source, { transforms: ["typescript"] }).code;

  // 先在禁网沙盒预检顶层代码，避免模型列表入口加载时偷偷发起请求。
  u.vm(javascript, undefined, { provider: safeId, networkPolicy: "blocked" });
  const runtime = u.vm(javascript, undefined, { provider: safeId });
  if (!runtime?.vendor?.inputValues || typeof runtime.listModels !== "function") {
    throw new Error("供应商未提供模型列表功能");
  }
  const privateInputs = options.privateInputs ?? await loadVendorPrivateInputs(safeId);
  Object.assign(runtime.vendor.inputValues, privateInputs);
  const remoteModels = await runtime.listModels();
  if (!Array.isArray(remoteModels)) throw new Error("模型列表响应格式无效");

  // 沙盒返回值仍在本地后端做二次收敛，绝不把密钥或任意对象透传到页面。
  const seen = new Set<string>();
  const models: RemoteVendorModel[] = [];
  for (const item of remoteModels) {
    if (!item || typeof item !== "object") continue;
    const idValue = typeof item.id === "string" ? item.id.trim() : "";
    if (!idValue || seen.has(idValue)) continue;
    seen.add(idValue);
    const model: RemoteVendorModel = { id: idValue };
    if (typeof item.object === "string") model.object = item.object;
    if (typeof item.created === "number" && Number.isFinite(item.created)) model.created = item.created;
    if (typeof item.owned_by === "string") model.owned_by = item.owned_by;
    models.push(model);
  }
  return models;
}

export interface RemoteVendorUpdate {
  hasUpdate: boolean;
  latestVersion: string;
  notice: string;
}

async function loadUpdateRuntime(
  id: string,
  options: { source?: string; privateInputs?: Record<string, string> } = {},
) {
  const safeId = assertSafeVendorId(id);
  const source = options.source ?? getCode(safeId);
  if (!source.trim()) throw new Error("供应商源码不存在或为空");
  const javascript = transform(source, { transforms: ["typescript"] }).code;
  // 更新入口和模型列表入口使用同一顶层禁网预检，下载只允许发生在显式调用阶段。
  u.vm(javascript, undefined, { provider: safeId, networkPolicy: "blocked" });
  const runtime = u.vm(javascript, undefined, { provider: safeId });
  if (!runtime?.vendor?.inputValues) throw new Error("供应商源码缺少 vendor 配置");
  const privateInputs = options.privateInputs ?? await loadVendorPrivateInputs(safeId);
  Object.assign(runtime.vendor.inputValues, privateInputs);
  return runtime;
}

export async function checkRemoteVendorUpdate(
  id: string,
  options: { source?: string; privateInputs?: Record<string, string> } = {},
): Promise<RemoteVendorUpdate> {
  const runtime = await loadUpdateRuntime(id, options);
  if (typeof runtime.checkForUpdates !== "function") throw new Error("供应商未提供检查更新功能");
  const result = await runtime.checkForUpdates();
  if (!result || typeof result !== "object") throw new Error("供应商更新检查响应无效");
  const latestVersion = typeof result.latestVersion === "string" ? result.latestVersion.trim() : "";
  if (!latestVersion) throw new Error("供应商更新检查缺少最新版本号");
  return {
    hasUpdate: result.hasUpdate === true,
    latestVersion,
    notice: typeof result.notice === "string" ? result.notice : "",
  };
}

export async function downloadRemoteVendorUpdate(
  id: string,
  options: { source?: string; privateInputs?: Record<string, string> } = {},
): Promise<string> {
  const runtime = await loadUpdateRuntime(id, options);
  if (typeof runtime.updateVendor !== "function") throw new Error("供应商未提供更新功能");
  const source = await runtime.updateVendor();
  if (typeof source !== "string" || !source.trim()) throw new Error("供应商更新源码为空");
  assertVendorSourceSize(source);
  return source;
}

export function getVendor(id: string) {
  const code = getCode(id);
  const jsCode = transform(code, { transforms: ["typescript"] }).code;
  const vendorData = u.vm(jsCode);
  return vendorData.vendor;
}

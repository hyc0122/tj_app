import { transform } from "sucrase";
import { z } from "zod";

import runCode from "@/utils/vm";
import { accountDatabase } from "@/utils/db";
import { loadVendorPrivateInputs, sanitizeVendorSourceSecrets } from "@/utils/vendor-private-config";
import { assertSafeVendorId, assertVendorSourceSize } from "@/utils/vendor-source-path";
import { getCode, writeCode } from "@/utils/vendor";

const vendorConfigSchema = z.object({
  id: z.string(),
  version: z.string().optional(),
  author: z.string(),
  description: z.string().optional(),
  name: z.string(),
  icon: z.string().optional(),
  inputs: z.array(z.object({
    key: z.string(),
    label: z.string(),
    type: z.enum(["text", "password", "url"]),
    required: z.boolean(),
    placeholder: z.string().optional(),
  })),
  inputValues: z.record(z.string(), z.string()),
  models: z.array(z.discriminatedUnion("type", [
    z.object({
      name: z.string(), modelName: z.string(), type: z.literal("text"), think: z.boolean(),
    }),
    z.object({
      name: z.string(), modelName: z.string(), type: z.literal("image"),
      mode: z.array(z.enum(["text", "singleImage", "multiReference"])),
    }),
    z.object({
      name: z.string(), modelName: z.string(), type: z.literal("video"),
      mode: z.array(z.union([
        z.enum([
          "singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional",
          "text", "audioReference", "videoReference",
        ]),
        z.array(z.string().regex(/^(videoReference|imageReference|audioReference):\d+$/)),
      ])),
      audio: z.union([z.literal("optional"), z.boolean()]),
      durationResolutionMap: z.array(z.object({
        duration: z.array(z.number()), resolution: z.array(z.string()),
      })),
    }),
  ])),
});

export interface PreparedVendorSourceUpdate {
  source: string;
  inputValues: Record<string, string>;
  models: unknown[];
  publicVendor: Omit<z.infer<typeof vendorConfigSchema>, "inputValues">;
}

/**
 * 在任何数据库或文件写入前完成编译、导出、身份和密钥保留校验。
 * 禁网预检可阻止下载到的模板在模块顶层偷偷发起请求。
 */
export function prepareVendorSourceUpdate(
  id: string,
  tsCode: string,
  currentInputs: Record<string, string>,
): PreparedVendorSourceUpdate {
  const safeId = assertSafeVendorId(id);
  assertVendorSourceSize(tsCode);
  const javascript = transform(tsCode, { transforms: ["typescript"] }).code;
  const runtime = runCode(javascript, undefined, {
    provider: safeId,
    networkPolicy: "blocked",
  });
  for (const exportName of ["textRequest", "imageRequest", "videoRequest", "vendor"] as const) {
    if (!runtime?.[exportName]) throw new Error(`脚本文件必须导出 ${exportName}`);
  }
  const parsed = vendorConfigSchema.safeParse(runtime.vendor);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("；");
    throw new Error(`vendor 配置校验失败：${details}`);
  }
  if (parsed.data.id !== safeId) throw new Error("供应商身份与已安装配置不一致");

  const mergedInputs = { ...currentInputs };
  for (const [key, value] of Object.entries(parsed.data.inputValues)) {
    // 下载源码里的空占位不得清除当前账号已有 API Key 或自定义基地址。
    if (value.length > 0 && !(key in mergedInputs)) mergedInputs[key] = value;
  }
  const source = sanitizeVendorSourceSecrets(tsCode, parsed.data.inputs, mergedInputs);
  const { inputValues: _privateInputs, ...publicVendor } = parsed.data;
  return {
    source,
    inputValues: mergedInputs,
    models: parsed.data.models,
    publicVendor,
  };
}

/** 原子更新账号库和本地源码文件；写盘失败时数据库事务会回滚。 */
export async function applyVendorSourceUpdate(id: string, tsCode: string) {
  const safeId = assertSafeVendorId(id);
  const database = accountDatabase();
  const exists = await database("o_vendorConfig").where("id", safeId).select("id").first();
  if (!exists) throw new Error("未找到该供应商配置");
  const currentInputs = await loadVendorPrivateInputs(safeId, database);
  const prepared = prepareVendorSourceUpdate(safeId, tsCode, currentInputs);
  const previousSource = getCode(safeId);
  const { afterVendorConfigWrite, commitVendorConfigMutation } = await import(
    "@/tianjiang/sync/profile-settings-adapter"
  );
  try {
    await commitVendorConfigMutation(database, { op: "upsert", id: safeId }, async (trx) => {
      await trx("o_vendorConfig").where("id", safeId).update({
        models: JSON.stringify(prepared.models),
        inputValues: JSON.stringify(prepared.inputValues),
      });
      // 文件替换位于数据库事务内；若写盘抛错，账号库与 outbox 一并回滚。
      writeCode(safeId, prepared.source);
    });
  } catch (error) {
    // 若事务在文件替换后失败，恢复原源码，避免数据库与文件版本分叉。
    if (previousSource) writeCode(safeId, previousSource);
    throw error;
  }
  await afterVendorConfigWrite({ op: "upsert", id: safeId });
  return prepared.publicVendor;
}

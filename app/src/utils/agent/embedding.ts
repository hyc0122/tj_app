import path from "path";
import fs from "fs";
import crypto from "node:crypto";

// ── 模型配置 ──
// 模块顶层禁止导入 db / transformers，避免 activateUserDatabase 动态 import 时环依赖或重型依赖。
type FeatureExtractionPipeline = {
  (text: string, opts: { pooling: string; normalize: boolean }): Promise<{ data: Float32Array }>;
  dispose?: () => Promise<void> | void;
};

let extractor: FeatureExtractionPipeline | null = null;
/** 当前 extractor 绑定的账号 segment + 配置摘要；变化时必须 dispose 后重建 */
let extractorBindingKey: string | null = null;

function digestConfig(modelOnnxFile: string, modelDtype: string): string {
  return crypto.createHash("sha256").update(`${modelOnnxFile}|${modelDtype}`).digest("hex").slice(0, 24);
}

/**
 * 计算当前账号的 binding key：segment + 模型路径配置摘要。
 * 无账号上下文时用固定 sentinel，避免跨账号静默复用。
 */
export function computeEmbeddingBindingKey(
  segment: string | null | undefined,
  modelOnnxFileJson: string,
  modelDtype: string,
): string {
  const seg = String(segment ?? "").trim() || "__no_account__";
  return `${seg}:${digestConfig(modelOnnxFileJson, modelDtype)}`;
}

export async function initEmbedding(): Promise<void> {
  const { getAccountSettings } = await import("@/utils/account-model-resolver");
  const { currentUserStorage } = await import("@/tianjiang/runtime/user-storage-context");
  const {
    assertSharedModelsIntegrity,
    requireSharedModelsRoot,
  } = await import("@/tianjiang/models/shared-models-root");

  // embedding 路径配置属于账号级设置，项目库不得覆盖
  const modelObj = await getAccountSettings(["modelOnnxFile", "modelDtype"]);
  const modelOnnxFileJson = modelObj.modelOnnxFile
    ? String(modelObj.modelOnnxFile)
    : JSON.stringify(["all-MiniLM-L6-v2", "onnx", "model_fp16.onnx"]);
  const modelDtype = modelObj.modelDtype ?? ("fp16" as const);
  const segment = currentUserStorage()?.segment ?? null;
  const bindingKey = computeEmbeddingBindingKey(segment, modelOnnxFileJson, String(modelDtype));

  if (extractor && extractorBindingKey === bindingKey) return;
  if (extractor && extractorBindingKey !== bindingKey) {
    await disposeEmbedding();
  }

  let modelOnnxFile: string[] = ["all-MiniLM-L6-v2", "onnx", "model_fp16.onnx"];
  try {
    const parsed = JSON.parse(modelOnnxFileJson);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      modelOnnxFile = parsed as string[];
    }
  } catch {
    // keep default
  }

  const modelsRoot = requireSharedModelsRoot();
  assertSharedModelsIntegrity(modelsRoot);
  const onnxPath = path.join(modelsRoot, ...modelOnnxFile);
  if (!fs.existsSync(onnxPath)) {
    throw new Error(`Embedding 模型文件不存在: ${onnxPath}`);
  }

  const { pipeline, env: transformersEnv } = await import("@huggingface/transformers");
  transformersEnv.allowRemoteModels = false;
  transformersEnv.allowLocalModels = true;
  transformersEnv.localModelPath = modelsRoot.replace(/\\/g, "/") + "/";

  const modelFolder = modelOnnxFile[0];
  // @ts-ignore - pipeline 重载联合类型过于复杂
  extractor = await pipeline("feature-extraction", modelFolder, { dtype: modelDtype });
  extractorBindingKey = bindingKey;
}

export async function getEmbedding(text: string): Promise<number[]> {
  await initEmbedding();
  const output = await extractor!(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  return a.reduce((dot, v, i) => dot + v * b[i], 0);
}

/** 释放 extractor；账号切换、退出、数据库关闭时必须调用。不触发 transformers/db 加载。 */
export async function disposeEmbedding(): Promise<void> {
  await extractor?.dispose?.();
  extractor = null;
  extractorBindingKey = null;
}

/** 测试/诊断：当前绑定 key（无 extractor 时为 null） */
export function getEmbeddingBindingKeyForTest(): string | null {
  return extractorBindingKey;
}

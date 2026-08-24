import { generateText, streamText, wrapLanguageModel, stepCountIs, extractReasoningMiddleware } from "ai";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import axios from "axios";
import { transform } from "sucrase";
import u from "@/utils";
import crypto from "node:crypto";
import { currentUserStorage } from "@/tianjiang/runtime/user-storage-context";
import {
  captureCurrentGenerationTask,
  runWithGenerationTaskCapture,
} from "@/tianjiang/tasks/generation-task-recovery";
import {
  prepareModelMediaReferences,
  preflightModelMediaReferences,
  type PersistedMediaReference,
} from "@/tianjiang/media/model-media-reference";
import {
  ADVANCED_DEPLOYMENT_KEYS,
  FROZEN_DEPLOYMENT_KEYS,
  type AdvancedDeploymentKey,
  type FrozenDeploymentKey,
} from "@/tianjiang/model/deployment-keys";
import {
  getAccountSetting,
  loadAccountVendorPrivateInputs,
  resolveAccountDeployConfig,
  resolveAccountDeployModelName,
  resolveAccountVendorRuntime,
} from "@/utils/account-model-resolver";
import {
  createSafeVendorGenerationError,
  rethrowVendorPhaseOr,
  safeVendorGenerationErrorSummary,
} from "@/tianjiang/storyboard/vendor-generation-safety";

/** 与冻结部署键注册表对齐；禁止任意 `${string}:${string}` 动态键绕过契约 */
type AiType = FrozenDeploymentKey;
/** 直连供应商:模型 仅用于已解析后的 vendorId:modelName，不是部署键 */
type ResolvedVendorModelKey = `${string}:${string}`;
type DeployOrResolvedKey = AiType | ResolvedVendorModelKey;

type FnName = "textRequest" | "imageRequest" | "videoRequest" | "ttsRequest";

const AiTypeValues: readonly string[] = FROZEN_DEPLOYMENT_KEYS;
const AdvancedKeySet = new Set<string>(ADVANCED_DEPLOYMENT_KEYS);

function isFrozenDeployKey(value: string): value is FrozenDeploymentKey {
  return AiTypeValues.includes(value);
}

function isAdvancedDeployKey(value: string): value is AdvancedDeploymentKey {
  return AdvancedKeySet.has(value);
}

/** 部署键解析：统一走账号级解析器，绝不读项目库 o_agentDeploy */
async function resolveModelName(value: DeployOrResolvedKey): Promise<ResolvedVendorModelKey> {
  if (isFrozenDeployKey(value)) {
    return resolveAccountDeployModelName(value);
  }
  // 仅允许 vendorId:modelName 形态的已解析键，禁止把任意高级键字面量当直连
  if (isAdvancedDeployKey(value)) {
    return resolveAccountDeployModelName(value);
  }
  return value as ResolvedVendorModelKey;
}

async function getModelConfig(value: DeployOrResolvedKey) {
  if (isFrozenDeployKey(value) || isAdvancedDeployKey(value)) {
    return resolveAccountDeployConfig(value);
  }
  return null;
}

async function getVendorTemplateFn(
  fnName: "textRequest",
  modelName: `${string}:${string}`,
): Promise<(think?: boolean, thinkLevel?: 0 | 1 | 2 | 3) => any>;
async function getVendorTemplateFn(fnName: Exclude<FnName, "textRequest">, modelName: `${string}:${string}`): Promise<(input: any) => any>;
async function getVendorTemplateFn(fnName: FnName, modelName: `${string}:${string}`): Promise<any> {
  // 供应商元数据与密钥一律来自账号库解析器
  const runtime = await resolveAccountVendorRuntime(modelName);
  const { vendorId: id, selectedModel, modelList } = runtime;
  const code = u.vendor.getCode(id);
  const jsCode = transform(code, { transforms: ["typescript"] }).code;
  const running = u.vm(jsCode, undefined, {
    provider: id,
    onRemoteTaskCreated: (remoteTaskId, metadata) =>
      captureCurrentGenerationTask(id, remoteTaskId, metadata.requestPath),
  });
  if (running.vendor) {
    // 私密输入只在后端执行前注入动态供应商实例，不经过任何列表/日志响应。
    Object.assign(running.vendor.inputValues, await loadAccountVendorPrivateInputs(id));
    running.vendor.models = modelList;
  }
  const fn = running[fnName];
  if (!fn) throw new Error(`未找到供应商配置中的函数`);
  if (fnName == "textRequest")
    return (think?: boolean, thinkLevel: 0 | 1 | 2 | 3 = 0) => {
      const effectiveThink = think ?? !!(selectedModel as { think?: boolean }).think;
      return fn(selectedModel, effectiveThink, thinkLevel);
    };
  else return <T>(input: T) => fn(input, selectedModel);
}

type PreparedVendorTemplate = {
  provider: string;
  vendorMetadata: Record<string, unknown>;
  execute(input: unknown): Promise<unknown>;
};

/**
 * 用禁网 VM 验证固定源码与导出函数；真正 VM 及供应商函数只在 execute 阶段创建。
 * 这样模板顶层 fetch/axios 也不能绕过整批本地预检门。
 */
async function prepareVendorTemplate(
  fnName: "imageRequest" | "videoRequest",
  modelName: `${string}:${string}`,
): Promise<PreparedVendorTemplate> {
  const runtime = await resolveAccountVendorRuntime(modelName, undefined, {
    templateNetworkPolicy: "blocked",
  });
  const { vendorId: provider, selectedModel, modelList, privateInputs } = runtime;
  const code = u.vendor.getCode(provider);
  const jsCode = transform(code, { transforms: ["typescript"] }).code;
  const instantiate = (networkPolicy: "enabled" | "blocked") => {
    const running = u.vm(jsCode, undefined, {
      provider,
      networkPolicy,
      ...(networkPolicy === "enabled" ? {
        onRemoteTaskCreated: (remoteTaskId, metadata) =>
          captureCurrentGenerationTask(provider, remoteTaskId, metadata.requestPath),
      } : {}),
    });
    if (running.vendor) {
      Object.assign(running.vendor.inputValues, privateInputs);
      running.vendor.models = modelList;
    }
    return running;
  };
  const preflight = instantiate("blocked");
  if (typeof preflight[fnName] !== "function") {
    throw new Error("未找到供应商配置中的函数");
  }
  // 中文注释：预备计划只保留非敏感能力元数据，禁止把 inputValues 密钥复制进批次计划。
  const vendorMetadata: Record<string, unknown> = preflight.vendor && typeof preflight.vendor === "object"
    ? {
        version: preflight.vendor.version,
        mediaCapabilities: preflight.vendor.mediaCapabilities,
      }
    : {};
  return {
    provider,
    vendorMetadata,
    execute: async (input) => {
      const running = instantiate("enabled");
      const fn = running[fnName];
      if (typeof fn !== "function") throw new Error("未找到供应商配置中的函数");
      return fn(input, selectedModel);
    },
  };
}

async function withTaskRecord<T>(
  modelKey: DeployOrResolvedKey,
  taskClass: string,
  describe: string,
  relatedObjects: string,
  projectId: number,
  requestInput: unknown,
  fn: (modelName: `${string}:${string}`, think: Boolean, thinkLevel: 0 | 1 | 2 | 3) => Promise<T>,
  safeFailureSummary?: string,
): Promise<T> {
  const modelName = await resolveModelName(modelKey);
  const [provider, model] = modelName.split(/:(.+)/);
  const projectUuid = currentUserStorage()?.projectUuid;
  if (!projectUuid) throw new Error("生成任务缺少当前用户项目上下文");
  const requestDigest = crypto
    .createHash("sha256")
    .update(JSON.stringify({ provider, model, taskClass, requestInput }))
    .digest("hex");
  const taskRecord = await u.task(projectId, taskClass, model, { describe: describe, content: relatedObjects });
  let remoteTaskAttached = false;
  try {
    const result = await runWithGenerationTaskCapture(
      provider,
      async (remoteTaskId, remoteStatusHint) => {
        await taskRecord.attachRemote({
          provider,
          remoteTaskId,
          projectUuid,
          requestDigest,
          remoteStatusHint,
        });
        remoteTaskAttached = true;
      },
      () => fn(modelName, false, 0),
    );

    await taskRecord(1);
    return result;
  } catch (e) {
    const message = safeFailureSummary ?? u.error(e).message;
    // 远端 ID 已落库后，网络/轮询异常不能把仍在运行的远端任务伪装成终态失败。
    if (remoteTaskAttached) await taskRecord.markTemporaryFailure(message);
    else await taskRecord(-1, message);
    if (safeFailureSummary) throw createSafeVendorGenerationError();
    throw new Error(message);
  }
}

async function urlToBase64(url: string, retries = 3, delay = 1000): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, { responseType: "arraybuffer" });
      const base64 = Buffer.from(res.data).toString("base64");
      return `${base64}`;
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise((resolve) => setTimeout(resolve, delay * attempt));
    }
  }
  throw new Error("urlToBase64 failed");
}
class AiText {
  private AiType: DeployOrResolvedKey;
  private think?: boolean;
  private thinkLevel: 0 | 1 | 2 | 3;
  constructor(AiType: DeployOrResolvedKey, think?: boolean, thinkLevel: 0 | 1 | 2 | 3 = 0) {
    this.AiType = AiType;
    this.think = think;
    this.thinkLevel = thinkLevel;
  }
  private async resolveModel(middleware?: any | any[]) {
    // 开发者工具开关为账号级设置
    const switchAiDevTool = await getAccountSetting("switchAiDevTool");
    const modelName = await resolveModelName(this.AiType);
    const sdkFn = await getVendorTemplateFn("textRequest", modelName);
    const baseModel = await sdkFn(this.think, this.thinkLevel);
    const mws = [
      ...(switchAiDevTool === "1" ? [devToolsMiddleware()] : []),
      ...(middleware ? (Array.isArray(middleware) ? middleware : [middleware]) : []),
    ];
    return mws.length > 0 ? wrapLanguageModel({ model: baseModel, middleware: mws.length === 1 ? mws[0] : mws }) : baseModel;
  }
  async invoke(input: Omit<Parameters<typeof generateText>[0], "model">) {
    const config = await getModelConfig(this.AiType);

    return generateText({
      ...(input.tools && { stopWhen: stepCountIs(Object.keys(input.tools).length * 50) }),
      ...input,
      model: await this.resolveModel(),
      ...(config?.temperature && { temperature: config.temperature }),
      ...(config?.maxOutputTokens && { maxOutputTokens: config.maxOutputTokens }),
    } as Parameters<typeof generateText>[0]);
  }
  async stream(input: Omit<Parameters<typeof streamText>[0], "model">) {
    const config = await getModelConfig(this.AiType);

    return streamText({
      ...(input.tools && { stopWhen: stepCountIs(Object.keys(input.tools).length * 50) }),
      ...input,
      model: await this.resolveModel(extractReasoningMiddleware({ tagName: "reasoning_content", separator: "\n" })),
      ...(config?.temperature && { temperature: config.temperature }),
      ...(config?.maxOutputTokens && { maxOutputTokens: config.maxOutputTokens }),
    } as Parameters<typeof streamText>[0]);
  }
}

function referenceList2imageBase642(id: string, input: any) {
  const version = u.vendor.getVendor(id).version;
  return referenceList2imageBase64ByVersion(version, input);
}

function referenceList2imageBase64ByVersion(version: unknown, input: any) {
  const parsedVersion = Number.parseFloat(String(version ?? ""));
  if (!Number.isFinite(parsedVersion) || parsedVersion < 2.0) {
    input.imageBase64 = input.referenceList.map((item: any) => item.base64);
    return input;
  }
  return input;
}

type MediaPayload =
  | { base64: string; media?: never }
  | { media: PersistedMediaReference; base64?: never };
export type ReferenceList =
  | ({ type: "image" } & MediaPayload)
  | ({ type: "audio" } & MediaPayload)
  | ({ type: "video" } & MediaPayload);

function capabilityForReference(
  provider: string,
  mediaType: "image" | "audio" | "video",
  vendorMetadata?: Record<string, unknown>,
): { supportsUrl: boolean; supportsInline: boolean } {
  const { resolveVendorMediaCapability } = require(
    "@/tianjiang/storyboard/vendor-media-capability",
  ) as typeof import("@/tianjiang/storyboard/vendor-media-capability");
  const form = resolveVendorMediaCapability(provider, mediaType, vendorMetadata).form;
  return {
    supportsUrl: form === "url",
    supportsInline: form === "inline",
  };
}

async function prepareVendorInput<T extends { referenceList?: ReferenceList[] }>(
  provider: string,
  input: T,
  vendorMetadata?: Record<string, unknown>,
): Promise<T & { referenceList: Array<{ type: "image" | "audio" | "video"; base64: string }> }> {
  const metadata = vendorMetadata ?? {};
  preflightVendorInput(provider, input, metadata);
  const prepared = [] as Array<{ type: "image" | "audio" | "video"; base64: string }>;
  for (const reference of input.referenceList ?? []) {
    const [item] = await prepareModelMediaReferences(
      [reference],
      capabilityForReference(provider, reference.type, metadata),
    );
    prepared.push(item);
  }
  return {
    ...input,
    referenceList: prepared,
  };
}

function preflightVendorInput<T extends { referenceList?: ReferenceList[] }>(
  provider: string,
  input: T,
  vendorMetadata: Record<string, unknown>,
): void {
  const { resolveVendorMediaCapability } = require(
    "@/tianjiang/storyboard/vendor-media-capability",
  ) as typeof import("@/tianjiang/storyboard/vendor-media-capability");
  const { VendorReferenceUnsupportedError } = require(
    "@/tianjiang/storyboard/vendor-generation-safety",
  ) as typeof import("@/tianjiang/storyboard/vendor-generation-safety");
  // 中文注释：先整批核对类型合同，禁止 URL 预检先失败而把不支持的音频伪装成配置错误。
  for (const reference of input.referenceList ?? []) {
    if (reference.media && resolveVendorMediaCapability(provider, reference.type, vendorMetadata).form === "none") {
      throw new VendorReferenceUnsupportedError();
    }
  }
  for (const reference of input.referenceList ?? []) {
    preflightModelMediaReferences(
      [reference],
      capabilityForReference(provider, reference.type, vendorMetadata),
    );
  }
}

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface TaskRecord {
  taskClass: string; // 任务分类
  describe: string; // 任务描述
  relatedObjects: string; // 相关对象信息，便于后续分析和追踪
  projectId: number; // 项目ID
}

class AiImage {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  private async prepareResolved(input: ImageConfig, modelName: `${string}:${string}`) {
    try {
      const template = await prepareVendorTemplate("imageRequest", modelName);
      preflightVendorInput(template.provider, input, template.vendorMetadata);
      return {
        stage: async () => {
          try {
            const vendorInput = await prepareVendorInput(
              template.provider,
              input,
              template.vendorMetadata,
            );
            referenceList2imageBase64ByVersion(template.vendorMetadata.version, vendorInput);
            return {
              execute: async () => {
                try {
                  this.result = String(await template.execute(vendorInput));
                  if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
                  return this;
                } catch (error) {
                  rethrowVendorPhaseOr("execute", error);
                }
              },
            };
          } catch (error) {
            rethrowVendorPhaseOr("stage", error);
          }
        },
      };
    } catch (error) {
      rethrowVendorPhaseOr("prepare", error);
    }
  }
  /** 中文注释：只完成模型、模板与媒体暂存，不调用可能收费的供应商函数。 */
  async prepare(input: ImageConfig) {
    return this.prepareResolved(input, await resolveModelName(this.key));
  }
  async run(input: ImageConfig, taskRecord?: TaskRecord) {
    if (taskRecord) {
      await withTaskRecord(
        this.key,
        taskRecord.taskClass,
        taskRecord.describe,
        taskRecord.relatedObjects,
        taskRecord.projectId,
        input,
        async (modelName) => (await (await this.prepareResolved(input, modelName)).stage()).execute(),
        safeVendorGenerationErrorSummary(),
      );
      return this;
    }
    return (await (await this.prepare(input)).stage()).execute();
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}

type VideoMode =
  | "singleImage" //单图参考
  | "startEndRequired" //首尾帧（两张都得有）
  | "endFrameOptional" //首尾帧（尾帧可选）
  | "startFrameOptional" //首尾帧（首帧可选）
  | "text" //文本
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[]; //多参考（数字代表限制数量）

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode[];
}

class AiVideo {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  private async prepareResolved(input: VideoConfig, modelName: `${string}:${string}`) {
    try {
      const template = await prepareVendorTemplate("videoRequest", modelName);
      preflightVendorInput(template.provider, input, template.vendorMetadata);
      return {
        stage: async () => {
          try {
            const vendorInput = await prepareVendorInput(
              template.provider,
              input,
              template.vendorMetadata,
            );
            referenceList2imageBase64ByVersion(template.vendorMetadata.version, vendorInput);
            return {
              execute: async () => {
                try {
                  this.result = String(await template.execute(vendorInput));
                  if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
                  return this;
                } catch (error) {
                  rethrowVendorPhaseOr("execute", error);
                }
              },
            };
          } catch (error) {
            rethrowVendorPhaseOr("stage", error);
          }
        },
      };
    } catch (error) {
      rethrowVendorPhaseOr("prepare", error);
    }
  }
  /** 中文注释：整批路由会先调用 prepare，所有本地阶段成功后才允许 execute。 */
  async prepare(input: VideoConfig) {
    return this.prepareResolved(input, await resolveModelName(this.key));
  }
  async run(input: VideoConfig, taskRecord?: TaskRecord) {
    if (taskRecord) {
      await withTaskRecord(
        this.key,
        taskRecord.taskClass,
        taskRecord.describe,
        taskRecord.relatedObjects,
        taskRecord.projectId,
        input,
        async (modelName) => (await (await this.prepareResolved(input, modelName)).stage()).execute(),
        safeVendorGenerationErrorSummary(),
      );
      return this;
    }
    return (await (await this.prepare(input)).stage()).execute();
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}
class AiAudio {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  async run(input: VideoConfig, taskRecord?: TaskRecord) {
    const modelName = await resolveModelName(this.key);
    const exec = async (mn: `${string}:${string}`) => {
      try {
        const fn = await getVendorTemplateFn("ttsRequest", mn);
        const provider = mn.split(/:(.+)/)[0];
        const vendorInput = await prepareVendorInput(provider, input);
        await referenceList2imageBase642(provider, vendorInput);
        this.result = await fn(vendorInput);

        if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
        return this;
      } catch (e) {}
    };
    if (taskRecord) {
      return withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, input, exec);
    }
    return await exec(modelName);
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}

export default {
  Text: (AiType: DeployOrResolvedKey, think?: boolean, thinkLevel?: 0 | 1 | 2 | 3) => new AiText(AiType, think, thinkLevel),
  Image: (key: `${string}:${string}`) => new AiImage(key),
  Video: (key: `${string}:${string}`) => new AiVideo(key),
  Audio: (key: `${string}:${string}`) => new AiAudio(key),
  Async: (key: string) => ({
    enqueue: async (input: {
      projectUuid: string;
      shotUuid: string;
      mediaType: "image" | "video";
      mode?: string;
      paidBatchConfirmed?: boolean;
    }) => {
      const { enqueueAsyncMediaTasks } = await import("@/tianjiang/model-providers/async-generation-service");
      const [result] = await enqueueAsyncMediaTasks({
        projectUuid: input.projectUuid,
        paidBatchConfirmed: input.paidBatchConfirmed === true,
        items: [{
          shotUuid: input.shotUuid,
          mediaType: input.mediaType,
          providerModel: key,
          // 中文注释：旧门面也必须进入统一 auto 解析，禁止把视频默认成图片模式。
          mode: input.mode ?? "auto",
        }],
      });
      return result;
    },
  }),
};

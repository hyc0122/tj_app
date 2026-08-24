export interface PersistedMediaReference {
  projectUuid?: string;
  relativePath?: string;
  objectKey?: string;
  md5: string;
  size: number;
}

export interface ModelMediaResolver {
  signObject?(objectKey: string, expiresSeconds: number): Promise<string>;
  stageLocalPath?(reference: PersistedMediaReference, expiresSeconds: number): Promise<string>;
}

export interface VendorMediaInputCapability {
  supportsUrl: boolean;
  supportsInline: boolean;
}

const INLINE_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

let activeResolver: ModelMediaResolver | undefined;

/**
 * 登录态只注入当前中央用户的短签适配器；退出或断网时传入 undefined 立即撤销。
 */
export function configureModelMediaResolver(resolver?: ModelMediaResolver): void {
  activeResolver = resolver;
}

export async function prepareModelMediaReferences<T extends {
  type: "image" | "audio" | "video";
  base64?: string;
  media?: PersistedMediaReference;
}>(
  references: T[] | undefined,
  capability: boolean | VendorMediaInputCapability,
): Promise<Array<Omit<T, "media"> & { base64: string }>> {
  const resolved = normalizeCapability(capability);
  preflightModelMediaReferences(references, resolved);
  if (!references?.length) return [];
  return Promise.all(references.map(async (reference) => {
    if (!reference.media) {
      if (typeof reference.base64 !== "string") throw new Error("模型媒体引用缺少内容");
      // 兼容旧供应商的瞬时内存参数；该值仍会被所有持久化入口拒绝。
      return { ...reference, base64: reference.base64 };
    }
    const payload = resolved.supportsUrl
      ? await resolveModelMediaURL(reference.media, requireActiveResolver(), { providerSupportsURL: true })
      : await materializeInlineProjectMedia(reference.media);
    const { media: _persistentReference, ...rest } = reference;
    return { ...rest, base64: payload };
  }));
}

/**
 * 仅校验持久引用与 resolver 能力，不调用 sign/stage。
 * 整批调用方必须先对全部项目执行本地预检，之后才可进入可能联网的 staging 阶段。
 */
export function preflightModelMediaReferences<T extends {
  type: "image" | "audio" | "video";
  base64?: string;
  media?: PersistedMediaReference;
}>(references: T[] | undefined, capability: boolean | VendorMediaInputCapability): void {
  const resolved = normalizeCapability(capability);
  const persisted = (references ?? []).filter((item) => item.media);
  if (persisted.length > 0 && !resolved.supportsUrl && !resolved.supportsInline) {
    const { VendorReferenceUnsupportedError } = require(
      "@/tianjiang/storyboard/vendor-generation-safety",
    ) as typeof import("@/tianjiang/storyboard/vendor-generation-safety");
    throw new VendorReferenceUnsupportedError();
  }
  for (const reference of references ?? []) {
    if (!reference.media) {
      if (typeof reference.base64 !== "string") throw new Error("模型媒体引用缺少内容");
      continue;
    }
    validatePersistedReference(reference.media);
    assertProjectMediaIdentitySync(reference.media);
    if (resolved.supportsUrl) {
      const resolver = requireActiveResolver();
      if (reference.media.objectKey && !resolver.signObject) {
        throw new Error("缺少对象存储短签 URL 适配器");
      }
      if (reference.media.relativePath && !resolver.stageLocalPath) {
        throw new Error("本地媒体必须交给 Task2 staging adapter 后才能调用模型");
      }
      continue;
    }
    if (!resolved.supportsInline) {
      const { VendorReferenceUnsupportedError } = require(
        "@/tianjiang/storyboard/vendor-generation-safety",
      ) as typeof import("@/tianjiang/storyboard/vendor-generation-safety");
      throw new VendorReferenceUnsupportedError();
    }
  }
}

function normalizeCapability(capability: boolean | VendorMediaInputCapability): VendorMediaInputCapability {
  if (typeof capability === "boolean") {
    return { supportsUrl: capability, supportsInline: false };
  }
  return {
    supportsUrl: capability.supportsUrl === true,
    supportsInline: capability.supportsInline === true,
  };
}

function requireActiveResolver(): ModelMediaResolver {
  if (!activeResolver) throw new Error("当前登录态未配置模型媒体短签适配器");
  return activeResolver;
}

function assertProjectMediaIdentitySync(reference: PersistedMediaReference): void {
  if (!reference.projectUuid || !reference.relativePath) return;
  const { currentUserStorage } = require("@/tianjiang/runtime/user-storage-context") as typeof import("@/tianjiang/runtime/user-storage-context");
  const getPath = (require("@/utils/getPath") as { default: () => string }).default;
  const { hashProjectFileIdentity } = require("./project-file-inventory") as typeof import("./project-file-inventory");
  const context = currentUserStorage();
  if (!context) throw new Error("内联参考素材缺少项目身份");
  let digest: { md5: string; size: number };
  try {
    digest = hashProjectFileIdentity(
      getPath(),
      reference.projectUuid,
      context.segment,
      reference.relativePath,
    );
  } catch {
    throw referenceIdentityMismatchError();
  }
  if (digest.md5.toLowerCase() !== reference.md5.toLowerCase() || digest.size !== reference.size) {
    throw referenceIdentityMismatchError();
  }
}

async function materializeInlineProjectMedia(reference: PersistedMediaReference): Promise<string> {
  const { currentUserStorage } = await import("@/tianjiang/runtime/user-storage-context");
  const getPath = (await import("@/utils/getPath")).default;
  const {
    assertOpenProjectFileHandleIdentity,
    classifyProjectFile,
    closeProjectFileHandle,
    readProjectFileFdSync,
  } = await import("./project-file-store");
  const { openProjectFileIdentity } = await import("./project-file-inventory");
  const { resolveVerifiedMediaMime } = await import("./transient-media");
  const context = currentUserStorage();
  if (!context || !reference.projectUuid || !reference.relativePath) {
    throw new Error("内联参考素材缺少项目身份");
  }
  const classified = classifyProjectFile(reference.relativePath);
  if (classified.mediaType !== "image" && classified.mediaType !== "video" && classified.mediaType !== "audio") {
    throw new Error("内联参考素材类型无效");
  }
  let opened: ReturnType<typeof openProjectFileIdentity>;
  try {
    opened = openProjectFileIdentity(
      getPath(),
      reference.projectUuid,
      context.segment,
      reference.relativePath,
    );
  } catch {
    throw referenceIdentityMismatchError();
  }
  let bytes: Buffer;
  try {
    if (opened.md5.toLowerCase() !== reference.md5.toLowerCase() || opened.size !== reference.size) {
      throw referenceIdentityMismatchError();
    }
    if (!Number.isSafeInteger(opened.size) || opened.size <= 0 || opened.size > INLINE_MEDIA_MAX_BYTES) {
      throw Object.assign(new Error("内联参考素材超过允许大小"), { code: "INLINE_MEDIA_SIZE_INVALID" });
    }
    bytes = Buffer.allocUnsafe(opened.size);
    assertOpenProjectFileHandleIdentity(opened);
    let position = 0;
    while (position < bytes.length) {
      const read = readProjectFileFdSync(opened.fd, bytes.subarray(position), bytes.length - position, position);
      if (read <= 0) throw new Error("内联参考素材读取不完整");
      position += read;
    }
    assertOpenProjectFileHandleIdentity(opened);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === "STORYBOARD_REFERENCE_IDENTITY_MISMATCH" || code === "INLINE_MEDIA_SIZE_INVALID") throw error;
    throw referenceIdentityMismatchError();
  } finally {
    closeProjectFileHandle(opened.fd);
  }
  const mime = resolveVerifiedMediaMime(reference.relativePath, bytes);
  // 中文注释：只在正式请求组装最后阶段驻留内存，禁止写库、记日志或长期缓存。
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function referenceIdentityMismatchError(): Error {
  return Object.assign(new Error("参考素材文件已变化，请重新预览确认"), {
    status: 400,
    code: "STORYBOARD_REFERENCE_IDENTITY_MISMATCH",
  });
}

/**
 * 持久层只接受路径/对象键和摘要；模型请求在最后一刻解析为短签 HTTPS URL。
 */
export async function resolveModelMediaURL(
  reference: PersistedMediaReference,
  resolver: ModelMediaResolver,
  options: { providerSupportsURL: boolean; expiresSeconds?: number },
): Promise<string> {
  validatePersistedReference(reference);
  if (!options.providerSupportsURL) {
    throw new Error("当前供应商不支持 URL 媒体输入，禁止回退为持久化图片 Base64");
  }
  const expiresSeconds = options.expiresSeconds ?? 300;
  if (!Number.isSafeInteger(expiresSeconds) || expiresSeconds < 30 || expiresSeconds > 900) {
    throw new Error("模型媒体短签有效期必须在 30 到 900 秒之间");
  }
  let url: string;
  if (reference.objectKey) {
    if (!resolver.signObject) throw new Error("缺少对象存储短签 URL 适配器");
    url = await resolver.signObject(reference.objectKey, expiresSeconds);
  } else {
    if (!resolver.stageLocalPath) {
      throw new Error("本地媒体必须交给 Task2 staging adapter 后才能调用模型");
    }
    url = await resolver.stageLocalPath(reference, expiresSeconds);
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("模型媒体适配器必须返回不含凭据字段的 HTTPS 短签 URL");
  }
  return url;
}

export function validatePersistedReference(reference: PersistedMediaReference): void {
  const locations = [reference.relativePath, reference.objectKey].filter(Boolean);
  if (
    locations.length !== 1
    || !/^[a-f0-9]{32}$/i.test(reference.md5)
    || !Number.isSafeInteger(reference.size)
    || reference.size < 0
  ) {
    throw new Error("持久媒体引用必须只含相对路径或对象键以及 md5/size");
  }
  if (
    reference.relativePath
    && (!reference.projectUuid
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reference.projectUuid))
  ) {
    throw new Error("本地媒体引用必须绑定项目 UUID");
  }
  const location = locations[0]!;
  if (
    location.startsWith("/")
    || location.includes("\\")
    || location.includes(":")
    || location.split("/").some((part) => !part || part === "." || part === "..")
    || /base64/i.test(location)
  ) {
    throw new Error("持久媒体路径或对象键无效");
  }
}

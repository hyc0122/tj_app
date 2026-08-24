import { z } from "zod";

/** 后台公开客户端配置：功能开关只控菜单可见性，不代替后端鉴权。 */
export const clientFeatureFlagsSchema = z.object({
  uiSettings: z.boolean(),
  languageSettings: z.boolean(),
  modelServices: z.boolean(),
  modelMapping: z.boolean(),
  agentConfig: z.boolean(),
  promptManagement: z.boolean(),
  skillsManagement: z.boolean(),
  agentMemory: z.boolean(),
  databaseOperations: z.boolean(),
  fileManagement: z.boolean(),
  otherConfiguration: z.boolean(),
  developerOptions: z.boolean(),
  checkUpdates: z.boolean(),
  logout: z.boolean(),
}).strict();

/** 与客户端历史硬编码一致的内置反馈地址。 */
export const PACKAGED_FEEDBACK_URL =
  "https://docs.qq.com/smartsheet/form/EmvmQBrmlPmr%2Fss_vsqk2v%2FvhiGzE?tab=ss_vsqk2v";

export const clientConfigSupportSchema = z.object({
  feedbackUrl: z.string().url().startsWith("https://"),
}).strict();

const publicClientConfigBaseSchema = z.object({
  configVersion: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
  onboarding: z.object({
    guideRevision: z.number().int().nonnegative(),
    // 后台默认值允许未配置；一旦配置则只接受 HTTPS 图片地址。
    supportQrCodeUrl: z.union([
      z.literal(""),
      z.string().url().startsWith("https://"),
    ]),
  }).strict(),
  featureFlags: clientFeatureFlagsSchema,
  updatePolicy: z.object({
    enabled: z.boolean(),
    channel: z.enum(["stable", "beta"]),
    manualDownloadOnly: z.literal(true),
  }).strict(),
  // 旧服务器可省略 support；解析后补齐内置降级，不使整份配置失败。
  support: clientConfigSupportSchema.optional(),
}).strict();

export type PublicClientConfig = z.infer<typeof publicClientConfigBaseSchema> & {
  support: { feedbackUrl: string };
};
export type ClientFeatureFlags = z.infer<typeof clientFeatureFlagsSchema>;

export const PACKAGED_PUBLIC_CLIENT_CONFIG: PublicClientConfig = Object.freeze({
  configVersion: 1,
  updatedAt: "2026-08-01T00:00:00+08:00",
  onboarding: {
    guideRevision: 1,
    supportQrCodeUrl: "https://cdn.j11.com.cn/tianjiang/guide-qr.png",
  },
  featureFlags: {
    uiSettings: true,
    languageSettings: true,
    modelServices: true,
    modelMapping: true,
    agentConfig: true,
    promptManagement: true,
    skillsManagement: true,
    agentMemory: true,
    databaseOperations: true,
    fileManagement: true,
    otherConfiguration: true,
    developerOptions: false,
    checkUpdates: true,
    logout: true,
  },
  updatePolicy: {
    enabled: true,
    channel: "stable" as const,
    manualDownloadOnly: true as const,
  },
  support: {
    feedbackUrl: PACKAGED_FEEDBACK_URL,
  },
});

export function parsePublicClientConfig(raw: unknown): PublicClientConfig {
  const parsed = publicClientConfigBaseSchema.parse(raw);
  const feedbackUrl =
    typeof parsed.support?.feedbackUrl === "string" && parsed.support.feedbackUrl.length > 0
      ? parsed.support.feedbackUrl
      : PACKAGED_FEEDBACK_URL;
  return {
    ...parsed,
    support: { feedbackUrl },
  };
}

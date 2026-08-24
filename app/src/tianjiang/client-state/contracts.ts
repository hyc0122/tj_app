import { z } from "zod";

/** 引导完成状态：按业务账号 + 设备 UUID 隔离，禁止 localStorage。 */
export const onboardingStateSchema = z.object({
  businessUserId: z.number().int().positive(),
  deviceUuid: z.string().min(8),
  completedRevision: z.number().int().nonnegative(),
  completedAt: z.string().min(1),
}).strict();

export type OnboardingState = z.infer<typeof onboardingStateSchema>;

export const putOnboardingBodySchema = z.object({
  completedRevision: z.number().int().nonnegative(),
}).strict();

export type PutOnboardingBody = z.infer<typeof putOnboardingBodySchema>;

export function parseOnboardingState(raw: unknown): OnboardingState {
  return onboardingStateSchema.parse(raw);
}

export function parsePutOnboardingBody(raw: unknown): PutOnboardingBody {
  return putOnboardingBodySchema.parse(raw);
}

/** 客户端引导标识使用固定白名单，禁止把外部输入拼接到持久化路径。 */
export const clientGuideIdSchema = z.enum(["hello", "production"]);

export type ClientGuideId = z.infer<typeof clientGuideIdSchema>;

/** 通用引导完成状态：不同引导、账号与设备完全隔离。 */
export const guideStateSchema = z.object({
  guideId: clientGuideIdSchema,
  businessUserId: z.number().int().positive(),
  deviceUuid: z.string().min(8),
  completedRevision: z.number().int().nonnegative(),
  completedAt: z.string().min(1),
}).strict();

export type GuideState = z.infer<typeof guideStateSchema>;

/** renderer 只允许提交版本号，账号与设备身份必须由 App 侧确定。 */
export const putGuideStateBodySchema = z.object({
  completedRevision: z.number().int().nonnegative(),
}).strict();

export type PutGuideStateBody = z.infer<typeof putGuideStateBodySchema>;

export function parseClientGuideId(raw: unknown): ClientGuideId {
  return clientGuideIdSchema.parse(raw);
}

export function parseGuideState(raw: unknown): GuideState {
  return guideStateSchema.parse(raw);
}

export function parsePutGuideStateBody(raw: unknown): PutGuideStateBody {
  return putGuideStateBodySchema.parse(raw);
}

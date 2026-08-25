import { z } from "zod";

/** 完全由用户触发的更新动作；路由 body 不得含 URL。 */
export const MANUAL_UPDATE_ACTIONS = [
  "check",
  "check-login-stable",
  "download-differential",
  "download-full",
  "cancel-download",
  "install",
  "show-file",
] as const;

export type UpdateAction = (typeof MANUAL_UPDATE_ACTIONS)[number];
export type UpdateChannel = "stable" | "beta";

export const updateActionSchema = z.enum(MANUAL_UPDATE_ACTIONS);

export const manualUpdateActionBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("check") }).strict(),
  z.object({ action: z.literal("check-login-stable") }).strict(),
  z.object({
    action: z.literal("download-differential"),
    channel: z.enum(["stable", "beta"]),
  }).strict(),
  z.object({
    action: z.literal("download-full"),
    channel: z.enum(["stable", "beta"]),
  }).strict(),
  z.object({ action: z.literal("cancel-download") }).strict(),
  z.object({ action: z.literal("install") }).strict(),
  z.object({ action: z.literal("show-file") }).strict(),
]);

export type ManualUpdateActionBody = z.infer<typeof manualUpdateActionBodySchema>;

export type ManualUpdateState =
  | "idle"
  | "unsupported"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "preparing_install"
  | "installing"
  | "error";

export const manualUpdateChannelSnapshotSchema = z.object({
  status: z.enum(["idle", "unsupported", "checking", "available", "current", "error"]),
  source: z.enum(["network", "cache", "none"]),
  latestVersion: z.string().optional(),
  sourceChannel: z.enum(["stable", "beta"]).optional(),
  packageSizeBytes: z.number().int().positive().optional(),
  required: z.boolean(),
  downloadAllowed: z.boolean(),
  errorCode: z.string().optional(),
}).strict();

export const manualUpdateSnapshotSchema = z.object({
  state: z.enum([
    "idle",
    "unsupported",
    "checking",
    "available",
    "downloading",
    "downloaded",
    "preparing_install",
    "installing",
    "error",
  ]),
  currentVersion: z.string().min(1),
  stable: manualUpdateChannelSnapshotSchema,
  beta: manualUpdateChannelSnapshotSchema,
  stableRequired: z.boolean(),
  loginAllowed: z.boolean(),
  selectedChannel: z.enum(["stable", "beta"]).nullable(),
  latestVersion: z.string().optional(),
  releaseNotes: z.string().optional(),
  packageSizeBytes: z.number().int().nonnegative().optional(),
  progress: z.number().min(0).max(100).optional(),
  transferredBytes: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().nonnegative().optional(),
  bytesPerSecond: z.number().nonnegative().optional(),
  errorMessage: z.string().optional(),
  warningMessage: z.string().optional(),
  downloadedPath: z.string().optional(),
  channel: z.enum(["stable", "beta"]).optional(),
}).strict();

export type ManualUpdateSnapshot = z.infer<typeof manualUpdateSnapshotSchema>;

export function parseManualUpdateActionBody(raw: unknown): ManualUpdateActionBody {
  return manualUpdateActionBodySchema.parse(raw);
}

export function parseManualUpdateSnapshot(raw: unknown): ManualUpdateSnapshot {
  return manualUpdateSnapshotSchema.parse(raw);
}

export type DreaminaMode =
  | "text2image"
  | "image2image"
  | "text2video"
  | "image2video"
  | "frames2video"
  | "multiframe2video"
  | "multimodal2video";

export const DREAMINA_MODES: readonly DreaminaMode[] = [
  "text2image",
  "image2image",
  "text2video",
  "image2video",
  "frames2video",
  "multiframe2video",
  "multimodal2video",
] as const;

export const DREAMINA_IMAGE_MODES: readonly DreaminaMode[] = ["text2image", "image2image"];
// 中文注释：与官方 Jimeng 工作台一致，未配置绝对路径时直接使用 PATH 中的 dreamina 命令。
export const DEFAULT_DREAMINA_EXECUTABLE = "dreamina";
export const DREAMINA_VIDEO_MODES: readonly DreaminaMode[] = [
  "text2video",
  "image2video",
  "frames2video",
  "multiframe2video",
  "multimodal2video",
];

export const DREAMINA_VIDEO_MODELS = [
  "seedance2.0",
  "seedance2.0fast",
  "seedance2.0mini",
  "seedance2.0_vip",
  "seedance2.0fast_vip",
] as const;

export type DreaminaVideoModel = (typeof DREAMINA_VIDEO_MODELS)[number];

// 中文注释：本机 CLI text2image -h 与 Jimeng _IMAGE_MODELS 明确支持的 --model_version。
// 5.0 Lite 没有官方 CLI 标识，不得写入此表。
export const DREAMINA_IMAGE_MODELS = ["5.0", "4.7", "4.6", "4.5"] as const;
export type DreaminaImageModel = (typeof DREAMINA_IMAGE_MODELS)[number];
export const DREAMINA_IMAGE_MODEL_LABELS: Record<DreaminaImageModel, string> = {
  "5.0": "Seedream 5.0 Pro",
  "4.7": "Seedream 4.7",
  "4.6": "Seedream 4.6",
  "4.5": "Seedream 4.5",
};

export type DreaminaSubmitResult =
  | { kind: "submitted"; submitId: string }
  | { kind: "completed"; submitId: string; files: readonly string[] }
  | { kind: "definite_failure"; code: string; retryable: boolean; message: string }
  | { kind: "outcome_unknown"; message: string };

export type DreaminaQueryResult =
  | { kind: "completed"; submitId: string; files: readonly string[] }
  | { kind: "running"; submitId: string }
  | { kind: "definite_failure"; code: string; retryable: boolean; message: string }
  | { kind: "outcome_unknown"; message: string };

export interface DreaminaSubmitInput {
  mode: DreaminaMode;
  prompt: string;
  ratio?: string;
  resolutionType?: string;
  videoResolution?: string;
  duration?: number;
  modelVersion?: string;
  pollSeconds?: number;
  generateNum?: number;
  width?: number;
  height?: number;
  images?: readonly string[];
  first?: string;
  last?: string;
  videos?: readonly string[];
  audios?: readonly string[];
  image?: string;
  video?: string;
  audio?: string;
  sessionId?: string;
}

export interface DreaminaModeCapability {
  enabled: boolean;
  disabledReason?: string;
  fields: readonly string[];
}

export interface DreaminaCapabilitySnapshot {
  installed: boolean;
  version: string | null;
  probedAt: number;
  loggedIn: boolean | null;
  loginReason?: string;
  modes: Record<DreaminaMode, DreaminaModeCapability>;
  capabilities: readonly DreaminaMode[];
  videoModels: readonly DreaminaVideoModel[];
}

export interface DreaminaReconcileInput {
  submitId?: string;
  sessionId?: string;
  createdAt?: number;
}

export interface DreaminaReconcileResult {
  kind: "recovered" | "unknown";
  submitId?: string;
  message: string;
}

export interface NativeMediaProvider {
  readonly providerId: "dreamina-cli";
  probe(): Promise<DreaminaCapabilitySnapshot>;
  ensureProjectSession(projectUuid: string, projectName: string): Promise<string>;
  submit(input: DreaminaSubmitInput): Promise<DreaminaSubmitResult>;
  query(input: { submitId: string; stagingDirectory: string }): Promise<DreaminaQueryResult>;
  reconcileUnknown(input: DreaminaReconcileInput): Promise<DreaminaReconcileResult>;
}

export interface DreaminaCliSettings {
  executablePath: string | null;
  maxConcurrency: number;
  pollSeconds: number;
  pauseNewClaims: boolean;
  pauseReason: DreaminaStoredPauseReason;
  enabled: boolean;
  preferredExecutionTarget?: DreaminaExecutionTarget;
  updatedAt: number;
}

export type DreaminaPauseReason = "none" | "disabled" | "manual_pause" | "lifecycle_drain";
export type DreaminaStoredPauseReason = Exclude<DreaminaPauseReason, "disabled">;

export type DreaminaExecutionTarget = "windows_native" | "wsl";

export interface DreaminaInstallStatus {
  state: "not_installed" | "installing" | "installed" | "repair_required" | "failed";
  version: string | null;
  executablePath: string | null;
  managed: boolean;
  checkedAt: number | null;
  reason?: string;
}

export interface DreaminaAccountStatus {
  state: "unknown" | "logged_out" | "authorizing" | "logged_in" | "expired" | "failed";
  points?: string;
  planName?: string;
  expiresAt?: string;
  refreshedAt?: number;
  reason?: string;
  /** 缓存中的上次账户态；不得单独当作本次已验证登录。 */
  lastKnownState?: DreaminaAccountStatus["state"];
  /** 仅在本次成功执行 user_credit 后为 true。 */
  verified?: boolean;
}

export interface DreaminaProviderStatus {
  // 中文注释：首选值来自可同步账号偏好，生效值来自当前设备检测，二者不得混为一谈。
  preferredExecutionTarget: DreaminaExecutionTarget;
  effectiveExecutionTarget: DreaminaExecutionTarget | null;
  install: DreaminaInstallStatus;
  account: DreaminaAccountStatus;
  capability: import("./capability-cache").DreaminaCapabilityCacheEntry;
  queue: {
    paused: boolean;
    pauseReason: DreaminaPauseReason;
    maxConcurrency: number;
    queued: number;
    active: number;
    unknown: number;
  };
}

export const DREAMINA_PROVIDER_ID = "dreamina-cli" as const;

export const DREAMINA_ERROR = {
  notInstalled: "DREAMINA_CLI_NOT_INSTALLED",
  notLoggedIn: "DREAMINA_CLI_NOT_LOGGED_IN",
  timeout: "DREAMINA_CLI_TIMEOUT",
  pathRejected: "DREAMINA_CLI_PATH_REJECTED",
  commandRejected: "DREAMINA_CLI_COMMAND_REJECTED",
  outcomeUnknown: "DREAMINA_CLI_OUTCOME_UNKNOWN",
  definiteFailure: "DREAMINA_CLI_DEFINITE_FAILURE",
  startFailed: "DREAMINA_CLI_START_FAILED",
  invalidArgument: "DREAMINA_CLI_INVALID_ARGUMENT",
  invalidConcurrency: "DREAMINA_CLI_INVALID_CONCURRENCY",
  invalidPollSeconds: "DREAMINA_CLI_INVALID_POLL_SECONDS",
  logoutUnconfirmed: "DREAMINA_CLI_LOGOUT_UNCONFIRMED",
} as const;

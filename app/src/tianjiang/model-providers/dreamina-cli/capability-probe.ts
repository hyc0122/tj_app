import {
  DREAMINA_MODES,
  DREAMINA_VIDEO_MODELS,
  type DreaminaCapabilitySnapshot,
  type DreaminaMode,
  type DreaminaModeCapability,
  type DreaminaVideoModel,
} from "./contracts";
import {
  DreaminaProcessError,
  parseWhitelistedOutput,
  runDreaminaCommand,
} from "./process-runner";
import {
  assertDreaminaProbeIdentity,
  isDreaminaEnablementStaleError,
} from "./dreamina-enablement";

const REQUIRED_FIELDS: Record<DreaminaMode, readonly string[]> = {
  text2image: ["--prompt", "--ratio", "--resolution_type"],
  image2image: ["--prompt", "--images", "--resolution_type"],
  text2video: ["--prompt", "--duration", "--ratio", "--video_resolution"],
  image2video: ["--prompt", "--image", "--duration"],
  frames2video: ["--prompt", "--first", "--last", "--duration"],
  multiframe2video: ["--prompt", "--images", "--duration"],
  // 中文注释：官方全能参考使用可重复 --image，并分别接受 --video/--audio，不能套用多帧的 --images。
  multimodal2video: ["--prompt", "--image", "--video", "--audio", "--duration"],
};

export async function probeDreaminaCapabilities(executablePath: string): Promise<DreaminaCapabilitySnapshot> {
  const probedAt = Date.now();
  const emptyModes = emptyModeMap("未完成能力探测");
  try {
    await assertDreaminaProbeIdentity(executablePath);
    const versionResult = await runDreaminaCommand({
      executablePath,
      args: ["version"],
      timeoutKind: "probe",
    });
    await assertDreaminaProbeIdentity(executablePath);
    if (versionResult.timedOut) {
      return {
        installed: false,
        version: null,
        probedAt,
        loggedIn: null,
        loginReason: "探测超时",
        modes: emptyModeMap("探测超时，已禁用该模式"),
        capabilities: [],
        videoModels: DREAMINA_VIDEO_MODELS,
      };
    }
    const version = extractVersion(versionResult.stdout) ?? "unknown";
    await assertDreaminaProbeIdentity(executablePath);
    const topHelp = await runDreaminaCommand({
      executablePath,
      args: ["-h"],
      timeoutKind: "probe",
    });
    await assertDreaminaProbeIdentity(executablePath);
    if (topHelp.timedOut || topHelp.exitCode !== 0) {
      const reason = topHelp.timedOut ? "顶层帮助探测超时" : "顶层帮助探测失败";
      return {
        installed: true,
        version,
        probedAt,
        loggedIn: null,
        loginReason: reason,
        modes: emptyModeMap(`${reason}，已禁用该模式`),
        capabilities: [],
        videoModels: DREAMINA_VIDEO_MODELS,
      };
    }
    const available = new Set(parseAvailableCommands(topHelp.stdout));
    const modes = {} as Record<DreaminaMode, DreaminaModeCapability>;
    let text2VideoHelp = "";
    for (const mode of DREAMINA_MODES) {
      if (!available.has(mode) && !topHelp.stdout.includes(mode)) {
        modes[mode] = {
          enabled: false,
          disabledReason: "当前 CLI 帮助未声明该模式，已禁用",
          fields: [],
        };
        continue;
      }
      await assertDreaminaProbeIdentity(executablePath);
      const help = await runDreaminaCommand({
        executablePath,
        args: [mode, "-h"],
        timeoutKind: "probe",
      });
      await assertDreaminaProbeIdentity(executablePath);
      if (help.timedOut || help.exitCode !== 0) {
        // 中文注释：超时或非零退出时 stdout 可能只是截断片段，必须整段丢弃并 fail-closed。
        modes[mode] = {
          enabled: false,
          disabledReason: help.timedOut ? "模式帮助探测超时，已禁用" : "模式帮助探测失败，已禁用",
          fields: [],
        };
        continue;
      }
      if (mode === "text2video") {
        // 中文注释：只有完整成功的 text2video 帮助才可作为模型来源。
        text2VideoHelp = help.stdout;
      }
      const fields = parseHelpFields(help.stdout);
      const missing = REQUIRED_FIELDS[mode].filter((field) => !fields.includes(field));
      if (missing.length > 0) {
        modes[mode] = {
          enabled: false,
          disabledReason: `当前 CLI 帮助缺少 ${missing.join("、")}，已禁用该模式`,
          fields,
        };
      } else {
        modes[mode] = { enabled: true, fields };
      }
    }
    await assertDreaminaProbeIdentity(executablePath);
    const credit = await inspectLogin(executablePath);
    return {
      installed: true,
      version,
      probedAt,
      loggedIn: credit.loggedIn,
      loginReason: credit.reason,
      modes,
      capabilities: DREAMINA_MODES.filter((mode) => modes[mode].enabled),
      videoModels: parseVideoModelsFromText2VideoHelp(text2VideoHelp),
    };
  } catch (error) {
    if (isDreaminaEnablementStaleError(error)) throw error;
    const message = error instanceof DreaminaProcessError
      ? error.message
      : "未安装即梦 CLI 或无法执行";
    return {
      installed: false,
      version: null,
      probedAt,
      loggedIn: false,
      loginReason: message,
      modes: emptyModesFrom(emptyModes, message),
      capabilities: [],
      videoModels: DREAMINA_VIDEO_MODELS,
    };
  }
}

export async function inspectLogin(executablePath: string): Promise<{
  loggedIn: boolean;
  reason?: string;
  creditBalance?: number;
  vip?: boolean;
  currency?: string;
}> {
  try {
    await assertDreaminaProbeIdentity(executablePath);
    const result = await runDreaminaCommand({
      executablePath,
      args: ["user_credit"],
      timeoutKind: "credit",
    });
    await assertDreaminaProbeIdentity(executablePath);
    if (result.timedOut) {
      return { loggedIn: false, reason: "积分自检超时" };
    }
    if (result.exitCode !== 0) {
      return { loggedIn: false, reason: "未登录即梦账号" };
    }
    const parsed = result.parsed ?? parseWhitelistedOutput(result.stdout) ?? {};
    const creditBalance = numberish(parsed.credit_balance ?? parsed.credit ?? parsed.balance);
    return {
      loggedIn: true,
      creditBalance,
      vip: typeof parsed.vip === "boolean" ? parsed.vip : undefined,
      currency: typeof parsed.currency === "string" ? parsed.currency : undefined,
    };
  } catch (error) {
    if (isDreaminaEnablementStaleError(error)) throw error;
    return { loggedIn: false, reason: "未登录即梦账号" };
  }
}

function extractVersion(stdout: string): string | null {
  return stdout.match(/(\d+\.\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
}

function parseAvailableCommands(help: string): string[] {
  return DREAMINA_MODES.filter((mode) => new RegExp(`\\b${mode}\\b`).test(help));
}

function parseHelpFields(help: string): string[] {
  return [...help.matchAll(/--[a-z0-9_]+/gi)].map((item) => item[0].toLowerCase());
}

function parseVideoModelsFromText2VideoHelp(help: string): readonly DreaminaVideoModel[] {
  const fieldIndex = help.toLowerCase().indexOf("--model_version");
  if (fieldIndex < 0) return DREAMINA_VIDEO_MODELS;

  const afterField = help.slice(fieldIndex);
  const nextField = afterField.slice("--model_version".length).search(/\r?\n\s*--[a-z0-9_]+/i);
  const modelSection = nextField < 0
    ? afterField
    : afterField.slice(0, "--model_version".length + nextField);
  const declared = new Set(
    [...modelSection.toLowerCase().matchAll(/[a-z0-9][a-z0-9._-]*/g)]
      .map((match) => match[0]),
  );
  const verified = DREAMINA_VIDEO_MODELS.filter((model) => declared.has(model));

  // 中文注释：只有五项全部精确声明才采纳 CLI 枚举，部分值或相似后缀均整体回退。
  return verified.length === DREAMINA_VIDEO_MODELS.length ? verified : DREAMINA_VIDEO_MODELS;
}

function emptyModeMap(reason: string): Record<DreaminaMode, DreaminaModeCapability> {
  return Object.fromEntries(
    DREAMINA_MODES.map((mode) => [mode, { enabled: false, disabledReason: reason, fields: [] }]),
  ) as unknown as Record<DreaminaMode, DreaminaModeCapability>;
}

function emptyModesFrom(
  modes: Record<DreaminaMode, DreaminaModeCapability>,
  reason: string,
): Record<DreaminaMode, DreaminaModeCapability> {
  return Object.fromEntries(
    Object.entries(modes).map(([mode, value]) => [mode, { ...value, enabled: false, disabledReason: reason }]),
  ) as unknown as Record<DreaminaMode, DreaminaModeCapability>;
}

function numberish(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

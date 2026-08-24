/**
 * 即梦 executablePath 变更的锁内步骤。
 * 中文注释：调用方必须已进入 runSerializedDreaminaEnablement；本 helper 不再取锁，避免嵌套死锁。
 */
import { currentUserStorage } from "@/tianjiang/runtime/user-storage-context";
import { bumpDreaminaProbeEpoch, syncDreaminaAuthoritativeProbeIdentity } from "./dreamina-enablement";
import { writeDreaminaRuntimeState } from "./runtime-state-store";
import { writeDreaminaCliSettings } from "./session-store";
import { invalidateDreaminaCapabilityCache } from "./capability-cache";
import { invalidateCurrentUserDreaminaStartupStatusCheck } from "./cli-truth";
import type { DreaminaCliSettings, DreaminaExecutionTarget } from "./contracts";

export async function applyDreaminaExecutablePathChangeInLock(input: {
  executablePath: string | null;
  expectedUpdatedAt: number;
  preferredExecutionTarget?: DreaminaExecutionTarget;
  maxConcurrency?: number;
  pollSeconds?: number;
  pauseNewClaims?: boolean;
}): Promise<DreaminaCliSettings> {
  const settings = await writeDreaminaCliSettings({
    executablePath: input.executablePath,
    maxConcurrency: input.maxConcurrency,
    pollSeconds: input.pollSeconds,
    pauseNewClaims: input.pauseNewClaims,
  }, { expectedUpdatedAt: input.expectedUpdatedAt });
  bumpDreaminaProbeEpoch();
  // 中文注释：路径迁移后立即记下权威身份，空 token 的 begin 不得再用旧路径拼新代际。
  syncDreaminaAuthoritativeProbeIdentity({
    executablePath: settings.executablePath,
    updatedAt: settings.updatedAt,
  });
  await writeDreaminaRuntimeState({
    executablePath: settings.executablePath,
    preferredExecutionTarget: input.preferredExecutionTarget,
    install: {
      checkedAt: null,
      reason: "待检测",
      executablePath: settings.executablePath,
    },
    account: {
      state: "unknown",
      reason: "待检测",
      refreshedAt: Date.now(),
    },
  }, { replaceAccount: true });
  invalidateCurrentUserDreaminaStartupStatusCheck();
  invalidateDreaminaCapabilityCache(currentUserStorage()?.segment);
  return settings;
}

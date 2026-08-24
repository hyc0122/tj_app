import express from "express";
import { z } from "zod";

import { success } from "@/lib/responseFormat";
import { validateSchema } from "@/middleware/middleware";
import { accountDb } from "@/utils/db";
import { buildDreaminaProviderStatus } from "@/tianjiang/model-providers/dreamina-cli/runtime-state-store";
import {
  readDreaminaCliSettings,
  resolveDreaminaPauseReason,
  writeDreaminaCliSettings,
} from "@/tianjiang/model-providers/dreamina-cli/session-store";
import { currentUserStorage } from "@/tianjiang/runtime/user-storage-context";
import {
  assertDreaminaEnablementRevision,
  bumpDreaminaEnablementRevision,
  endDreaminaEnablementProbe,
  isDreaminaEnablementStaleError,
  readDreaminaProbeEpoch,
  reserveDreaminaProbeForCurrentSettings,
  runSerializedDreaminaEnablement,
  runWithDreaminaProbeToken,
  type DreaminaProbeToken,
} from "@/tianjiang/model-providers/dreamina-cli/dreamina-enablement";
import {
  DREAMINA_CLI_SET_ENABLED_FAILED,
  toSafeDreaminaSettingsError,
} from "@/tianjiang/model-providers/dreamina-cli/safe-settings-error";

const router = express.Router();

let afterLockBeforeProbeHookForTests: (() => Promise<void> | void) | null = null;

export function setDreaminaSetEnabledAfterLockBeforeProbeHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  afterLockBeforeProbeHookForTests = hook;
}

let afterBeginBeforeEnsureHookForTests: (() => Promise<void> | void) | null = null;

export function setDreaminaSetEnabledAfterBeginBeforeEnsureHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  afterBeginBeforeEnsureHookForTests = hook;
}

const setEnabledSchema = z.object({
  enabled: z.boolean(),
}).strict();

async function readQueueSnapshot(settings: Awaited<ReturnType<typeof readDreaminaCliSettings>>) {
  const pauseReason = resolveDreaminaPauseReason(settings);
  try {
    const [queued, held, unknown] = await Promise.all([
      accountDb("o_dreaminaCliDispatch").where({ queueState: "queued" }).select("taskUuid"),
      accountDb("o_dreaminaCliDispatch").where({ slotHeld: 1 }).select("taskUuid"),
      accountDb("o_dreaminaCliDispatch").where({ providerState: "unknown" }).select("taskUuid"),
    ]);
    return {
      paused: pauseReason !== "none",
      pauseReason,
      maxConcurrency: settings.maxConcurrency,
      queued: queued.length,
      active: held.length,
      unknown: unknown.length,
    };
  } catch {
    return {
      paused: pauseReason !== "none",
      pauseReason,
      maxConcurrency: settings.maxConcurrency,
      queued: 0,
      active: 0,
      unknown: 0,
    };
  }
}

async function presentEnabledStatus() {
  const settings = await readDreaminaCliSettings();
  const queue = await readQueueSnapshot(settings);
  const status = await buildDreaminaProviderStatus(settings, queue);
  return {
    enabled: settings.enabled,
    updatedAt: settings.updatedAt,
    install: status.install,
    account: status.account,
    capability: status.capability,
    queue: {
      ...status.queue,
      paused: resolveDreaminaPauseReason(settings) !== "none",
      pauseReason: resolveDreaminaPauseReason(settings),
    },
  };
}

export default router.post(
  "/",
  validateSchema(setEnabledSchema),
  async (req, res) => {
    try {
      const enabled = req.body.enabled === true;
      let probeIdentity: {
        revision: number;
        epoch: number;
        executablePath: string | null;
        updatedAt: number;
      } | undefined;
      const revision = await runSerializedDreaminaEnablement(async () => {
        const nextRevision = bumpDreaminaEnablementRevision();
        if (!enabled) {
          // 中文注释：关闭先取得排他领取门，再等待“关闭前已进入”的他人 boundary；自己的 ALS owner 不自等。
          const {
            pauseDreaminaClaimsForEnablement,
            waitForDreaminaClaimBoundaryDrain,
          } = await import(
            "@/tianjiang/model-providers/dreamina-cli/scheduler"
          );
          const leave = pauseDreaminaClaimsForEnablement();
          try {
            await writeDreaminaCliSettings({ enabled: false });
            await waitForDreaminaClaimBoundaryDrain();
          } finally {
            leave();
          }
          const { invalidateCurrentUserDreaminaStartupStatusCheck } = await import(
            "@/tianjiang/model-providers/dreamina-cli/cli-truth"
          );
          invalidateCurrentUserDreaminaStartupStatusCheck();
          return nextRevision;
        }
        await writeDreaminaCliSettings({ enabled: true });
        const { invalidateCurrentUserDreaminaStartupStatusCheck } = await import(
          "@/tianjiang/model-providers/dreamina-cli/cli-truth"
        );
        invalidateCurrentUserDreaminaStartupStatusCheck();
        const { invalidateDreaminaCapabilityCache } = await import(
          "@/tianjiang/model-providers/dreamina-cli/capability-cache"
        );
        invalidateDreaminaCapabilityCache(currentUserStorage()?.segment);
        const enabledSettings = await readDreaminaCliSettings();
        probeIdentity = {
          revision: nextRevision,
          epoch: readDreaminaProbeEpoch(),
          executablePath: enabledSettings.executablePath,
          updatedAt: enabledSettings.updatedAt,
        };
        return nextRevision;
      });
      void revision;
      if (!enabled) {
        return res.status(200).send(success(await presentEnabledStatus()));
      }
      if (afterLockBeforeProbeHookForTests) await afterLockBeforeProbeHookForTests();
      if (!probeIdentity) {
        return res.status(200).send(success(await presentEnabledStatus()));
      }
      let probeToken: DreaminaProbeToken | null;
      try {
        probeToken = await reserveDreaminaProbeForCurrentSettings({
          executablePath: probeIdentity.executablePath,
          updatedAt: probeIdentity.updatedAt,
        });
      } catch (err) {
        if (!isDreaminaEnablementStaleError(err)) throw err;
        return res.status(200).send(success(await presentEnabledStatus()));
      }
      if (!probeToken) {
        return res.status(200).send(success(await presentEnabledStatus()));
      }
      if (afterBeginBeforeEnsureHookForTests) await afterBeginBeforeEnsureHookForTests();
      try {
        await runWithDreaminaProbeToken(probeToken, async () => {
          assertDreaminaEnablementRevision(probeToken);
          const { ensureDreaminaStartupStatusCheck, resolveDreaminaExecutable } = await import(
            "@/tianjiang/model-providers/dreamina-cli/cli-truth"
          );
          const probe = await ensureDreaminaStartupStatusCheck();
          assertDreaminaEnablementRevision(probeToken);
          if (probe.install.state === "installed" && probe.install.resolvedExecutablePath) {
            const { refreshDreaminaCapabilities } = await import(
              "@/tianjiang/model-providers/dreamina-cli/capability-cache"
            );
            const { probeDreaminaCapabilities } = await import(
              "@/tianjiang/model-providers/dreamina-cli/capability-probe"
            );
            const executable = await resolveDreaminaExecutable((await readDreaminaCliSettings()).executablePath);
            assertDreaminaEnablementRevision(probeToken);
            await refreshDreaminaCapabilities({
              force: true,
              probe: async () => {
                assertDreaminaEnablementRevision(probeToken);
                return probeDreaminaCapabilities(executable);
              },
            });
          }
          assertDreaminaEnablementRevision(probeToken);
          if ((await readDreaminaCliSettings()).enabled) {
            const { wakeDreaminaScheduler } = await import(
              "@/tianjiang/model-providers/dreamina-cli/scheduler"
            );
            wakeDreaminaScheduler();
          }
        });
      } catch (err) {
        // 中文注释：旧打开探测过期只丢弃结果，不得把已关闭的 enabled 改回 true。
        if (!isDreaminaEnablementStaleError(err)) throw err;
      } finally {
        endDreaminaEnablementProbe(probeToken);
      }
      return res.status(200).send(success(await presentEnabledStatus()));
    } catch (err) {
      const safe = toSafeDreaminaSettingsError(err, DREAMINA_CLI_SET_ENABLED_FAILED);
      return res.status(safe.status).send({
        code: safe.code,
        message: safe.message,
      });
    }
  },
);

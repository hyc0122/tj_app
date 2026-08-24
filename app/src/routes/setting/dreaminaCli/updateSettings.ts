import express from "express";
import { z } from "zod";

import { success } from "@/lib/responseFormat";
import { validateSchema } from "@/middleware/middleware";
import { DREAMINA_ERROR } from "@/tianjiang/model-providers/dreamina-cli/contracts";
import { normalizeDreaminaExecutableInput } from "@/tianjiang/model-providers/dreamina-cli/cli-truth";
import {
  readDreaminaRuntimeState,
  writeDreaminaRuntimeState,
} from "@/tianjiang/model-providers/dreamina-cli/runtime-state-store";
import {
  readDreaminaCliSettings,
  resolveDreaminaPauseReason,
  writeDreaminaCliSettings,
} from "@/tianjiang/model-providers/dreamina-cli/session-store";
import { applyDreaminaExecutablePathChangeInLock } from "@/tianjiang/model-providers/dreamina-cli/path-transition";
import {
  endDreaminaEnablementProbe,
  isDreaminaEnablementStaleError,
  readDreaminaEnablementRevision,
  readDreaminaProbeEpoch,
  reserveDreaminaProbeForCurrentSettings,
  runSerializedDreaminaEnablement,
  runWithDreaminaProbeToken,
  type DreaminaProbeToken,
} from "@/tianjiang/model-providers/dreamina-cli/dreamina-enablement";

const router = express.Router();

let afterInitialReadHookForTests: (() => Promise<void> | void) | null = null;
let afterLockBeforeProbeHookForTests: (() => Promise<void> | void) | null = null;
let afterBeginBeforeEnsureHookForTests: (() => Promise<void> | void) | null = null;

export function setDreaminaUpdateSettingsAfterInitialReadHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  afterInitialReadHookForTests = hook;
}

export function setDreaminaUpdateSettingsAfterLockBeforeProbeHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  afterLockBeforeProbeHookForTests = hook;
}

export function setDreaminaUpdateSettingsAfterBeginBeforeEnsureHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  afterBeginBeforeEnsureHookForTests = hook;
}

const updateSettingsSchema = z.object({
  executablePath: z.string().nullable().optional(),
  maxConcurrency: z.number().int().min(1).max(8).optional(),
  pollSeconds: z.number().int().min(5).max(300).optional(),
  preferredExecutionTarget: z.enum(["windows_native", "wsl"]).optional(),
}).strict();

export default router.post(
  "/",
  validateSchema(updateSettingsSchema),
  async (req, res) => {
    try {
      const executablePath = req.body.executablePath === undefined
        ? undefined
        : normalizeDreaminaExecutableInput(req.body.executablePath);
      const previous = await readDreaminaCliSettings();
      // 中文注释：测试钩子插在锁外 initial read 之后，覆盖“读完 previous 再决定是否进锁”的窗口。
      if (afterInitialReadHookForTests) await afterInitialReadHookForTests();
      let settings = previous;
      let pathChanged = false;
      let probeIdentity: {
        revision: number;
        epoch: number;
        executablePath: string | null;
        updatedAt: number;
      } | undefined;
      // 中文注释：所有写请求都进同一把账号级串行锁，包括不带 executablePath 的辅助设置。
      settings = await runSerializedDreaminaEnablement(async () => {
        const latest = await readDreaminaCliSettings();
        if (
          executablePath !== undefined
          && String(executablePath ?? "") !== String(latest.executablePath ?? "")
        ) {
          // 中文注释：锁内确认路径变化后才做迁移；写库、epoch、runtime、cache 必须同锁原子完成。
          pathChanged = true;
          const next = await applyDreaminaExecutablePathChangeInLock({
            executablePath,
            expectedUpdatedAt: latest.updatedAt,
            preferredExecutionTarget: req.body.preferredExecutionTarget,
            maxConcurrency: req.body.maxConcurrency,
            pollSeconds: req.body.pollSeconds,
          });
          if (next.enabled) {
            probeIdentity = {
              revision: readDreaminaEnablementRevision(),
              epoch: readDreaminaProbeEpoch(),
              executablePath: next.executablePath,
              updatedAt: next.updatedAt,
            };
          }
          return next;
        }
        const next = await writeDreaminaCliSettings({
          maxConcurrency: req.body.maxConcurrency,
          pollSeconds: req.body.pollSeconds,
        });
        if (req.body.preferredExecutionTarget !== undefined) {
          await writeDreaminaRuntimeState({
            preferredExecutionTarget: req.body.preferredExecutionTarget,
          });
        }
        return next;
      });
      // 中文注释：锁已释放、尚未 begin；此处用锁内快照做 CAS，过期身份不得改 token。
      if (afterLockBeforeProbeHookForTests) await afterLockBeforeProbeHookForTests();
      const shouldProbe = Boolean(settings.enabled && pathChanged && probeIdentity);
      if (shouldProbe && probeIdentity) {
        const { ensureDreaminaStartupStatusCheck } = await import(
          "@/tianjiang/model-providers/dreamina-cli/cli-truth"
        );
        let reservedToken: DreaminaProbeToken | undefined;
        try {
          reservedToken = await reserveDreaminaProbeForCurrentSettings({
            executablePath: probeIdentity.executablePath,
            updatedAt: probeIdentity.updatedAt,
          }) ?? undefined;
        } catch (err) {
          if (!isDreaminaEnablementStaleError(err)) throw err;
        }
        if (reservedToken) {
          try {
            await runWithDreaminaProbeToken(reservedToken, async () => {
              if (afterBeginBeforeEnsureHookForTests) await afterBeginBeforeEnsureHookForTests();
              await ensureDreaminaStartupStatusCheck();
            });
          } catch (err) {
            if (!isDreaminaEnablementStaleError(err)) throw err;
          } finally {
            endDreaminaEnablementProbe(reservedToken);
          }
        }
      }
      const runtime = await readDreaminaRuntimeState();
      return res.status(200).send(success({
        executablePath: runtime.executablePath ?? settings.executablePath,
        maxConcurrency: settings.maxConcurrency,
        pollSeconds: settings.pollSeconds,
        pauseNewClaims: settings.pauseNewClaims,
        pauseReason: resolveDreaminaPauseReason(settings),
        enabled: settings.enabled,
        preferredExecutionTarget: runtime.preferredExecutionTarget,
        updatedAt: settings.updatedAt,
        install: runtime.install,
        account: runtime.account,
      }));
    } catch (err) {
      const { toSafeDreaminaSettingsError, DREAMINA_CLI_SETTINGS_SAVE_FAILED_MESSAGE } = await import(
        "@/tianjiang/model-providers/dreamina-cli/safe-settings-error"
      );
      const safe = toSafeDreaminaSettingsError(
        err,
        req.body.pollSeconds !== undefined
          ? DREAMINA_ERROR.invalidPollSeconds
          : DREAMINA_ERROR.invalidConcurrency,
        DREAMINA_CLI_SETTINGS_SAVE_FAILED_MESSAGE,
      );
      return res.status(safe.status).send({
        code: safe.code,
        message: safe.message,
      });
    }
  },
);

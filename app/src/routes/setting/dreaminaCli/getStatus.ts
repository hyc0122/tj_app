import express from "express";

import { success } from "@/lib/responseFormat";
import { accountDb } from "@/utils/db";
import type { DreaminaAccountStatus } from "@/tianjiang/model-providers/dreamina-cli/contracts";
import type { DreaminaSelfCheckResult } from "@/tianjiang/model-providers/dreamina-cli/cli-truth";
import {
  readDreaminaCliSettings,
  resolveDreaminaPauseReason,
} from "@/tianjiang/model-providers/dreamina-cli/session-store";
import { buildDreaminaProviderStatus } from "@/tianjiang/model-providers/dreamina-cli/runtime-state-store";
import {
  assertDreaminaProbeIdentity,
  endDreaminaEnablementProbe,
  isDreaminaEnablementStaleError,
  reserveDreaminaProbeForCurrentSettings,
  runDreaminaAfterSettingsReadBeforeBeginHookForTests,
  runWithDreaminaProbeToken,
} from "@/tianjiang/model-providers/dreamina-cli/dreamina-enablement";

export {
  setDreaminaAfterSettingsReadBeforeBeginHookForTests,
  setDreaminaBeginCreatedHookForTests,
} from "@/tianjiang/model-providers/dreamina-cli/dreamina-enablement";
import {
  DREAMINA_CLI_GET_STATUS_FAILED,
  DREAMINA_CLI_GET_STATUS_FAILED_MESSAGE,
  toSafeDreaminaSettingsError,
} from "@/tianjiang/model-providers/dreamina-cli/safe-settings-error";

const router = express.Router();

function accountAfterStartupCheck(
  account: DreaminaAccountStatus,
  probe: DreaminaSelfCheckResult | null,
): DreaminaAccountStatus {
  if (!probe) {
    return { ...account, verified: false };
  }
  // 中文注释：verified 只认本次（含 TTL/inFlight）version/-h + user_credit 成功。
  if (probe.account.state === "logged_in" || probe.account.state === "logged_out") {
    const next: DreaminaAccountStatus = {
      ...account,
      state: probe.account.state,
      verified: true,
    };
    if (probe.account.points) next.points = probe.account.points;
    if (probe.account.reason) next.reason = probe.account.reason;
    return next;
  }
  return {
    ...account,
    state: probe.account.state === "failed" || account.state === "logged_in"
      ? (probe.account.state === "failed" ? "failed" : "unknown")
      : account.state,
    verified: false,
  };
}

export default router.get("/", async (_req, res) => {
  try {
    const initial = await readDreaminaCliSettings();
    // 中文注释：测试钩子覆盖“已读 settings、尚未 begin/拼装 revision+epoch”的窗口。
    await runDreaminaAfterSettingsReadBeforeBeginHookForTests();
    const { readDreaminaRuntimeState } = await import(
      "@/tianjiang/model-providers/dreamina-cli/runtime-state-store"
    );
    const priorAccount = (await readDreaminaRuntimeState()).account;
    const priorLastKnown = priorAccount.state === "logged_in"
      ? "logged_in"
      : priorAccount.lastKnownState;
    let probe: DreaminaSelfCheckResult | null = null;
    if (initial.enabled !== false) {
      let token;
      try {
        token = await reserveDreaminaProbeForCurrentSettings({
          executablePath: initial.executablePath,
          updatedAt: initial.updatedAt,
        });
      } catch (err) {
        if (!isDreaminaEnablementStaleError(err)) throw err;
        token = null;
      }
      if (token) {
        try {
          probe = await runWithDreaminaProbeToken(token, async () => {
            const { ensureDreaminaStartupStatusCheck } = await import(
              "@/tianjiang/model-providers/dreamina-cli/cli-truth"
            );
            // 中文注释：enabled 时等待同一次启动检测，复用 TTL 与 inFlight，禁止另起一套 CLI 服务。
            const result = await ensureDreaminaStartupStatusCheck();
            // 中文注释：最终身份必须仍在 token 上下文中核对，禁止 ALS 结束后空校验。
            await assertDreaminaProbeIdentity(initial.executablePath, token);
            return result;
          });
        } catch (err) {
          if (!isDreaminaEnablementStaleError(err)) throw err;
          probe = null;
        } finally {
          endDreaminaEnablementProbe(token);
        }
      }
    }
    // 中文注释：探测可能推进 updatedAt/路径；必须重新读取同一账号权威快照再投影。
    const settings = await readDreaminaCliSettings();
    let queue = {
      paused: resolveDreaminaPauseReason(settings) !== "none",
      pauseReason: resolveDreaminaPauseReason(settings),
      maxConcurrency: settings.maxConcurrency,
      queued: 0,
      active: 0,
      unknown: 0,
    };
    try {
      const [queued, held, unknown] = await Promise.all([
        accountDb("o_dreaminaCliDispatch").where({ queueState: "queued" }).select("taskUuid"),
        accountDb("o_dreaminaCliDispatch").where({ slotHeld: 1 }).select("taskUuid"),
        accountDb("o_dreaminaCliDispatch").where({ providerState: "unknown" }).select("taskUuid"),
      ]);
      queue = {
        paused: resolveDreaminaPauseReason(settings) !== "none",
        pauseReason: resolveDreaminaPauseReason(settings),
        maxConcurrency: settings.maxConcurrency,
        queued: queued.length,
        active: held.length,
        unknown: unknown.length,
      };
    } catch {
      // 队列投影失败时仍返回缓存安装/账户，不得伪装探测成功。
    }
    const status = await buildDreaminaProviderStatus(settings, queue);
    const account = accountAfterStartupCheck(status.account, probe);
    const installReady = status.install?.state === "installed"
      && Boolean(status.install?.executablePath);
    if (!installReady && account.state !== "logged_in" && priorLastKnown) {
      account.lastKnownState = priorLastKnown;
      account.verified = false;
    }
    return res.status(200).send(success({
      ...status,
      account,
      enabled: settings.enabled,
      updatedAt: settings.updatedAt,
    }));
  } catch (err) {
    const safe = toSafeDreaminaSettingsError(
      err,
      DREAMINA_CLI_GET_STATUS_FAILED,
      DREAMINA_CLI_GET_STATUS_FAILED_MESSAGE,
    );
    return res.status(safe.status).send({
      code: safe.code,
      message: safe.message,
    });
  }
});

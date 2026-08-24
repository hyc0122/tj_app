import express from "express";

import { success } from "@/lib/responseFormat";
import { writeDreaminaCapabilityCache } from "@/tianjiang/model-providers/dreamina-cli/capability-cache";
import { probeDreaminaCapabilities } from "@/tianjiang/model-providers/dreamina-cli/capability-probe";
import {
  persistDreaminaTruthCheck,
  performDreaminaTruthCheck,
  presentSelfCheckPayload,
} from "@/tianjiang/model-providers/dreamina-cli/cli-truth";
import { writeDreaminaRuntimeState } from "@/tianjiang/model-providers/dreamina-cli/runtime-state-store";

const router = express.Router();

export default router.post("/", async (_req, res) => {
  try {
    const {
      endDreaminaEnablementProbe,
      reserveDreaminaProbeForCurrentSettings,
      runDreaminaAfterSettingsReadBeforeBeginHookForTests,
      runWithDreaminaProbeToken,
    } = await import(
      "@/tianjiang/model-providers/dreamina-cli/dreamina-enablement"
    );
    const { readDreaminaCliSettings } = await import(
      "@/tianjiang/model-providers/dreamina-cli/session-store"
    );
    const settings = await readDreaminaCliSettings();
    // 中文注释：测试钩子覆盖“已读 settings、尚未 begin/拼装 revision+epoch”的窗口。
    await runDreaminaAfterSettingsReadBeforeBeginHookForTests();
    const token = await reserveDreaminaProbeForCurrentSettings({
      executablePath: settings.executablePath,
      updatedAt: settings.updatedAt,
    });
    if (!token) {
      return res.status(200).send(success(presentSelfCheckPayload({
        install: {
          state: "not_installed",
          resolvedExecutablePath: null,
          version: null,
          reason: "即梦 CLI 已关闭",
          checkedAt: Date.now(),
        },
        account: { state: "unknown", reason: "即梦 CLI 已关闭", checkedAt: Date.now() },
      })));
    }
    const result = await runWithDreaminaProbeToken(token, async () => {
      const checked = await persistDreaminaTruthCheck(await performDreaminaTruthCheck({ includeLogin: true }));
      if (checked.install.state === "installed" && checked.install.resolvedExecutablePath) {
        try {
          const snapshot = await probeDreaminaCapabilities(checked.install.resolvedExecutablePath);
          writeDreaminaCapabilityCache({
            state: snapshot.installed ? "ready" : "disabled",
            snapshot,
            checkedAt: Date.now(),
          });
          await writeDreaminaRuntimeState({
            install: {
              state: snapshot.installed ? "installed" : "not_installed",
              version: snapshot.version ?? checked.install.version,
              executablePath: checked.install.resolvedExecutablePath,
              managed: false,
              checkedAt: Date.now(),
            },
          });
        } catch {
          // 能力探测失败不得回写矛盾登录态。
        }
      }
      return checked;
    }).finally(() => endDreaminaEnablementProbe(token));
    return res.status(200).send(success(presentSelfCheckPayload(result)));
  } catch (err) {
    const { toSafeDreaminaSettingsError } = await import(
      "@/tianjiang/model-providers/dreamina-cli/safe-settings-error"
    );
    const safe = toSafeDreaminaSettingsError(err, "DREAMINA_CLI_GET_STATUS_FAILED", "即梦自检失败");
    return res.status(safe.status).send({
      code: safe.code,
      message: safe.message,
      data: { loggedIn: false },
    });
  }
});

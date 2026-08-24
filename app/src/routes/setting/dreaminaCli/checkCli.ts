import express from "express";

import { success } from "@/lib/responseFormat";
import {
  persistDreaminaTruthCheck,
  probeDreaminaCliAvailability,
} from "@/tianjiang/model-providers/dreamina-cli/cli-truth";

const router = express.Router();

export default router.post("/", async (_req, res) => {
  try {
    const { readDreaminaCliSettings } = await import(
      "@/tianjiang/model-providers/dreamina-cli/session-store"
    );
    const {
      endDreaminaEnablementProbe,
      isDreaminaEnablementStaleError,
      reserveDreaminaProbeForCurrentSettings,
      runDreaminaAfterSettingsReadBeforeBeginHookForTests,
      runWithDreaminaProbeToken,
    } = await import(
      "@/tianjiang/model-providers/dreamina-cli/dreamina-enablement"
    );
    const settings = await readDreaminaCliSettings();
    // 中文注释：测试钩子覆盖“已读 settings、尚未 begin/拼装 revision+epoch”的窗口。
    await runDreaminaAfterSettingsReadBeforeBeginHookForTests();
    const token = await reserveDreaminaProbeForCurrentSettings({
      executablePath: settings.executablePath,
      updatedAt: settings.updatedAt,
    });
    if (!token) {
      return res.status(200).send(success({
        available: false,
        resolvedExecutablePath: null,
        version: null,
        reason: "即梦 CLI 已关闭",
        install: { state: "not_installed", resolvedExecutablePath: null, version: null, reason: "即梦 CLI 已关闭" },
        account: { state: "unknown", verified: false },
      }));
    }
    const result = await runWithDreaminaProbeToken(token, async () => {
      const install = await probeDreaminaCliAvailability();
      return persistDreaminaTruthCheck({
        install,
        account: {
          state: "unknown",
          reason: install.state === "installed" ? "尚未检测登录" : (install.reason || "未找到可执行文件"),
          checkedAt: Date.now(),
        },
      });
    }).finally(() => endDreaminaEnablementProbe(token));
    return res.status(200).send(success({
      available: result.install.state === "installed",
      resolvedExecutablePath: result.install.resolvedExecutablePath,
      version: result.install.version,
      reason: result.install.reason,
      install: result.install,
      account: {
        ...result.account,
        verified: false,
      },
    }));
  } catch (err) {
    const { toSafeDreaminaSettingsError } = await import(
      "@/tianjiang/model-providers/dreamina-cli/safe-settings-error"
    );
    const safe = toSafeDreaminaSettingsError(err, "DREAMINA_CLI_GET_STATUS_FAILED", "检测 CLI 失败");
    return res.status(safe.status).send({
      code: safe.code,
      message: safe.message,
    });
  }
});

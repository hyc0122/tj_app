import express from "express";

import { success } from "@/lib/responseFormat";
import { readDreaminaRuntimeState } from "@/tianjiang/model-providers/dreamina-cli/runtime-state-store";
import {
  readDreaminaCliSettings,
  resolveDreaminaPauseReason,
} from "@/tianjiang/model-providers/dreamina-cli/session-store";

const router = express.Router();

export default router.get("/", async (_req, res) => {
  try {
    const { awaitSettingsDependentRead } = await import("@/tianjiang/sync/profile-settings-adapter");
    await awaitSettingsDependentRead();
    const settings = await readDreaminaCliSettings();
    const runtime = await readDreaminaRuntimeState();
    return res.status(200).send(success({
      // 中文注释：设置接口返回用户配置命令；运行时解析出的绝对路径由状态接口单独展示。
      executablePath: settings.executablePath,
      maxConcurrency: settings.maxConcurrency,
      pollSeconds: settings.pollSeconds,
      pauseNewClaims: settings.pauseNewClaims,
      pauseReason: resolveDreaminaPauseReason(settings),
      enabled: settings.enabled,
      preferredExecutionTarget: runtime.preferredExecutionTarget,
      updatedAt: settings.updatedAt,
    }));
  } catch (err) {
    const { toSafeDreaminaSettingsError, DREAMINA_CLI_GET_SETTINGS_FAILED, DREAMINA_CLI_GET_SETTINGS_FAILED_MESSAGE } = await import(
      "@/tianjiang/model-providers/dreamina-cli/safe-settings-error"
    );
    const safe = toSafeDreaminaSettingsError(
      err,
      DREAMINA_CLI_GET_SETTINGS_FAILED,
      DREAMINA_CLI_GET_SETTINGS_FAILED_MESSAGE,
    );
    return res.status(safe.status).send({
      code: safe.code,
      message: safe.message,
    });
  }
});

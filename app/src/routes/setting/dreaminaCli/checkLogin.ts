import express from "express";

import { error, success } from "@/lib/responseFormat";
import {
  persistDreaminaTruthCheck,
  performDreaminaTruthCheck,
  presentSelfCheckPayload,
} from "@/tianjiang/model-providers/dreamina-cli/cli-truth";

const router = express.Router();

export default router.post("/", async (_req, res) => {
  try {
    const {
      endDreaminaEnablementProbe,
      isDreaminaEnablementStaleError,
      reserveDreaminaProbeForCurrentSettings,
      runWithDreaminaProbeToken,
    } = await import("@/tianjiang/model-providers/dreamina-cli/dreamina-enablement");
    const token = await reserveDreaminaProbeForCurrentSettings();
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
    try {
      const result = await runWithDreaminaProbeToken(token, async () =>
        persistDreaminaTruthCheck(await performDreaminaTruthCheck({ includeLogin: true })));
      return res.status(200).send(success(presentSelfCheckPayload(result)));
    } catch (err) {
      if (!isDreaminaEnablementStaleError(err)) throw err;
      const { toSafeDreaminaSettingsError } = await import(
        "@/tianjiang/model-providers/dreamina-cli/safe-settings-error"
      );
      const safe = toSafeDreaminaSettingsError(err);
      return res.status(safe.status).send({ code: safe.code, message: safe.message });
    } finally {
      endDreaminaEnablementProbe(token);
    }
  } catch (err) {
    const { toSafeDreaminaSettingsError } = await import(
      "@/tianjiang/model-providers/dreamina-cli/safe-settings-error"
    );
    const { isDreaminaEnablementStaleError } = await import(
      "@/tianjiang/model-providers/dreamina-cli/dreamina-enablement"
    );
    if (isDreaminaEnablementStaleError(err)) {
      const safe = toSafeDreaminaSettingsError(err);
      return res.status(safe.status).send({ code: safe.code, message: safe.message });
    }
    return res.status(400).send(error(err instanceof Error ? err.message : "检测登录失败", null, 400));
  }
});

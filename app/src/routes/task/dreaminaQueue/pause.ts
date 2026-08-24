import express from "express";

import { success } from "@/lib/responseFormat";
import { getDreaminaQueueState } from "@/tianjiang/model-providers/dreamina-cli/scheduler";
import { writeDreaminaCliSettings } from "@/tianjiang/model-providers/dreamina-cli/session-store";
import { runSerializedDreaminaEnablement } from "@/tianjiang/model-providers/dreamina-cli/dreamina-enablement";
import {
  DREAMINA_QUEUE_PAUSE_FAILED,
  DREAMINA_QUEUE_PAUSE_FAILED_MESSAGE,
  toSafeDreaminaSettingsError,
} from "@/tianjiang/model-providers/dreamina-cli/safe-settings-error";

const router = express.Router();

export default router.post("/", async (_req, res) => {
  try {
    await runSerializedDreaminaEnablement(() => writeDreaminaCliSettings({ pauseReason: "manual_pause" }));
    res.status(200).send(success(await getDreaminaQueueState()));
  } catch (err) {
    // 中文注释：未知异常固定脱敏，禁止把路径、SQL、Cookie 或堆栈返回前端。
    const safe = toSafeDreaminaSettingsError(
      err,
      DREAMINA_QUEUE_PAUSE_FAILED,
      DREAMINA_QUEUE_PAUSE_FAILED_MESSAGE,
    );
    res.status(safe.status).send({ code: safe.code, message: safe.message });
  }
});

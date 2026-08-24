import express from "express";

import { error, success } from "@/lib/responseFormat";
import { writeDreaminaCliSettings } from "@/tianjiang/model-providers/dreamina-cli/session-store";
import {
  getDreaminaQueueState,
  isDreaminaLifecycleDrainActiveForCurrentUser,
  wakeDreaminaScheduler,
} from "@/tianjiang/model-providers/dreamina-cli/scheduler";
import { runSerializedDreaminaEnablement } from "@/tianjiang/model-providers/dreamina-cli/dreamina-enablement";
import {
  DREAMINA_QUEUE_RESUME_FAILED,
  DREAMINA_QUEUE_RESUME_FAILED_MESSAGE,
  toSafeDreaminaSettingsError,
} from "@/tianjiang/model-providers/dreamina-cli/safe-settings-error";

const router = express.Router();

export default router.post("/", async (_req, res) => {
  try {
    if (isDreaminaLifecycleDrainActiveForCurrentUser()) {
      res.status(409).send(error("退出暂停仍在排空提交临界区，请稍后重试", null, 409));
      return;
    }
    await runSerializedDreaminaEnablement(() => writeDreaminaCliSettings({ pauseReason: "none" }));
    if (isDreaminaLifecycleDrainActiveForCurrentUser()) {
      // 中文注释：检查与设置写入之间若新 pause 到达，必须恢复持久暂停，禁止短暂开门。
      await runSerializedDreaminaEnablement(() => writeDreaminaCliSettings({ pauseReason: "lifecycle_drain" }));
      res.status(409).send(error("退出暂停仍在排空提交临界区，请稍后重试", null, 409));
      return;
    }
    wakeDreaminaScheduler();
    res.status(200).send(success(await getDreaminaQueueState()));
  } catch (err) {
    // 中文注释：明确的生命周期冲突仍走上方 409；其余异常只返回稳定安全码。
    const safe = toSafeDreaminaSettingsError(
      err,
      DREAMINA_QUEUE_RESUME_FAILED,
      DREAMINA_QUEUE_RESUME_FAILED_MESSAGE,
    );
    res.status(safe.status).send({ code: safe.code, message: safe.message });
  }
});

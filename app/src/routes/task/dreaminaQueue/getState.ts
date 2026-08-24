import express from "express";

import { success } from "@/lib/responseFormat";
import { recoverOrphanedDreaminaLifecycleDrain } from "@/tianjiang/model-providers/dreamina-cli/recovery";
import {
  getDreaminaQueueState,
  wakeDreaminaScheduler,
} from "@/tianjiang/model-providers/dreamina-cli/scheduler";

const DREAMINA_QUEUE_STATE_FAILED = "DREAMINA_QUEUE_STATE_FAILED";
const DREAMINA_QUEUE_STATE_FAILED_MESSAGE = "读取即梦队列失败，请稍后重试";

const router = express.Router();

export default router.get("/", async (_req, res) => {
  try {
    const recovered = await recoverOrphanedDreaminaLifecycleDrain({ enabledOnly: true });
    // 中文注释：只有确实解除孤儿生命周期暂停后才唤醒，手动暂停和关闭状态保持静默。
    if (recovered) wakeDreaminaScheduler();
    res.status(200).send(success(await getDreaminaQueueState()));
  } catch {
    // 中文注释：禁止把数据库、路径或底层异常回显给页面。
    res.status(500).send({
      code: DREAMINA_QUEUE_STATE_FAILED,
      message: DREAMINA_QUEUE_STATE_FAILED_MESSAGE,
    });
  }
});

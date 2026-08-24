import express from "express";

import { error, success } from "@/lib/responseFormat";
import { accountDb, db as activeDb } from "@/utils/db";
import { runWithProjectStorage } from "@/tianjiang/runtime/user-storage-context";
import { shouldDispatchOnThisDevice } from "@/tianjiang/model-providers/dreamina-cli/task-store";
import {
  createEnqueueRequestIntentDigest,
  DreaminaEnqueueError,
  enqueueAsyncMediaTasks,
  normalizeDreaminaClientOperationId,
  replayAcceptedDreaminaEnqueue,
} from "@/tianjiang/model-providers/async-generation-service";
import type { FinalGenerationRequest } from "@/tianjiang/storyboard/storyboard-generation-service";
import { getStableDeviceUUID } from "@/tianjiang/auth/device";
import getPath from "@/utils/getPath";

const router = express.Router();
class RetryValidationError extends Error {}

export default router.post("/", async (req, res) => {
  try {
    const parentTaskUuid = String(req.body?.taskUuid ?? "");
    if (!parentTaskUuid) throw new RetryValidationError("缺少 taskUuid");
    if (!req.body?.clientOperationId) throw new RetryValidationError("缺少 clientOperationId");
    const clientOperationId = normalizeDreaminaClientOperationId(req.body.clientOperationId);
    const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid: parentTaskUuid }).first();
    if (!dispatch) throw new RetryValidationError("任务不属于当前账号或不存在");
    const projectUuid = String(dispatch.projectUuid).toLowerCase();
    const requestIntentDigest = createEnqueueRequestIntentDigest({
      projectUuid,
      action: "retry",
      paidBatchConfirmed: false,
      items: [{ parentTaskUuid }],
    });
    const replay = await replayAcceptedDreaminaEnqueue({
      projectUuid,
      clientOperationId,
      requestIntentDigest,
    });
    if (replay) {
      res.status(200).send(success(retryResponse(replay, parentTaskUuid, clientOperationId)));
      return;
    }
    if (String(dispatch.queueState) !== "terminal"
      || String(dispatch.providerState) !== "failed"
      || Number(dispatch.slotHeld) !== 0
      || Number(dispatch.dispatchReady ?? 0) !== 1) {
      // 中文注释：账号耐久终态是收费事实；活动、未知、占槽或待恢复父任务都禁止分叉付费重试。
      throw new RetryValidationError("只有已确认失败且完成恢复的任务可以重试");
    }
    if (!shouldDispatchOnThisDevice(String(dispatch.originDeviceUuid), getStableDeviceUUID(getPath()))) {
      throw new RetryValidationError("只能在原设备重试该任务");
    }
    const parent = await runWithProjectStorage(projectUuid, () =>
      activeDb("o_storyboardGenerationTask").where({ taskUuid: parentTaskUuid }).first());
    if (!parent) throw new RetryValidationError("项目任务不存在");
    const status = String(parent.status);
    if (status !== "failed_fatal" && status !== "failed_retryable") {
      throw new RetryValidationError("只有确定失败的任务可以重试");
    }
    let request: FinalGenerationRequest;
    try {
      request = JSON.parse(String(parent.parametersJson ?? "")) as FinalGenerationRequest;
    } catch {
      throw new RetryValidationError("原任务最终参数损坏，禁止自动重试");
    }
    // 中文注释：付费重试复用生成 operation 协议，避免跨库失败或响应丢失后产生第二个子任务。
    const tasks = await enqueueAsyncMediaTasks({
      projectUuid,
      clientOperationId,
      requestIntentDigest,
      paidBatchConfirmed: false,
      items: [{
        shotUuid: String(parent.shotUuid),
        parentTaskUuid,
        mediaType: parent.mediaType === "video" ? "video" : "image",
        providerModel: String(parent.modelName),
        mode: String(parent.mode),
        request,
      }],
    });
    res.status(200).send(success(retryResponse(tasks, parentTaskUuid, clientOperationId)));
  } catch (err) {
    if (err instanceof DreaminaEnqueueError) {
      res.status(err.status).send({ code: err.code, message: err.message, data: err.data });
      return;
    }
    if (err instanceof RetryValidationError) {
      res.status(400).send(error(err.message));
      return;
    }
    res.status(500).send(error("重试失败，请稍后再试", null, 500));
  }
});

function retryResponse(
  tasks: Awaited<ReturnType<typeof enqueueAsyncMediaTasks>>,
  parentTaskUuid: string,
  clientOperationId: string,
) {
  return {
    taskUuid: tasks[0]?.taskUuid,
    parentTaskUuid,
    clientOperationId: clientOperationId.toLowerCase(),
    status: tasks[0]?.status ?? "queued",
    tasks,
  };
}

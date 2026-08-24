import express from "express";

import { error, success } from "@/lib/responseFormat";
import { accountDb, db as activeDb } from "@/utils/db";
import { runWithProjectStorage } from "@/tianjiang/runtime/user-storage-context";
import { upsertPendingMutationJournalInTrx } from "@/tianjiang/runtime/legacy-mutation-journal";
import { shouldDispatchOnThisDevice } from "@/tianjiang/model-providers/dreamina-cli/task-store";
import { getStableDeviceUUID } from "@/tianjiang/auth/device";
import getPath from "@/utils/getPath";

const router = express.Router();
class CancelValidationError extends Error {}

export default router.post("/", async (req, res) => {
  try {
    const taskUuid = String(req.body?.taskUuid ?? "");
    if (!taskUuid) throw new CancelValidationError("缺少 taskUuid");
    const dispatch = await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).first();
    if (!dispatch) throw new CancelValidationError("任务不属于当前账号或不存在");
    if (Number(dispatch.dispatchReady ?? 1) !== 1) {
      // 中文注释：未 ready 的占位属于整批恢复协议，禁止单项取消破坏批次原子性。
      throw new CancelValidationError("任务入队仍在恢复，暂不可取消");
    }
    if (!shouldDispatchOnThisDevice(String(dispatch.originDeviceUuid), getStableDeviceUUID(getPath()))) {
      throw new CancelValidationError("只能在原设备取消尚未提交的任务");
    }
    if (String(dispatch.queueState) !== "queued" || String(dispatch.providerState) !== "not_sent") {
      throw new CancelValidationError("只能取消尚未提交的排队任务");
    }
    const updated = await accountDb("o_dreaminaCliDispatch")
      .where({ taskUuid, queueState: "queued", providerState: "not_sent" })
      .update({
        queueState: "terminal",
        providerState: "failed",
        slotHeld: 0,
        // 中文注释：账号库先提交耐久镜像标记；项目库失败后由启动恢复幂等前滚。
        providerResultJson: JSON.stringify({ localCancelPending: true }),
        updatedAt: Date.now(),
      });
    if (!updated) throw new CancelValidationError("只能取消尚未提交的排队任务");
    await runWithProjectStorage(String(dispatch.projectUuid), async () => {
      await activeDb.transaction(async (trx) => {
        const mirrored = await trx("o_storyboardGenerationTask").where({ taskUuid, status: "queued" }).update({
          status: "cancelled_local",
          updatedAt: Date.now(),
        });
        if (Number(mirrored) !== 1) {
          // 中文注释：账号库 marker 已耐久；项目镜像缺失/竞态时保留 marker 交恢复处理，禁止假成功。
          throw new Error("DREAMINA_CANCEL_PROJECT_MIRROR_CONFLICT");
        }
        await upsertPendingMutationJournalInTrx(trx, "dreaminaCancel");
      });
    });
    await accountDb("o_dreaminaCliDispatch").where({ taskUuid }).update({
      providerResultJson: null,
      updatedAt: Date.now(),
    });
    res.status(200).send(success({ cancelled: true, taskUuid }));
  } catch (err) {
    if (err instanceof CancelValidationError) {
      res.status(400).send(error(err.message));
      return;
    }
    res.status(500).send(error("取消排队失败，请稍后再试", null, 500));
  }
});

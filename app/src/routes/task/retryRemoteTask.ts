import express from "express";
import { z } from "zod";

import { validateFields } from "@/middleware/middleware";
import { success, error } from "@/lib/responseFormat";
import { db } from "@/utils/db";
import {
  recoverGenerationTasks,
  registeredGenerationTaskPoller,
  retryExistingRemoteTask,
} from "@/tianjiang/tasks/generation-task-recovery";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    taskId: z.number().int().positive(),
    projectId: z.number().int().positive(),
  }),
  async (req, res) => {
    try {
      // 人工操作也只重新查询原 remoteTaskId，不会重新提交生成请求。
      await retryExistingRemoteTask(db, req.body.taskId);
      const summary = await recoverGenerationTasks(db, registeredGenerationTaskPoller);
      res.status(200).send(success(summary));
    } catch (caught) {
      res.status(422).send(error(caught instanceof Error ? caught.message : "任务重试失败"));
    }
  },
);

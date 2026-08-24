import express from "express";
import { z } from "zod";

import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { resolveUnknownTask } from "@/tianjiang/model-providers/dreamina-cli/recovery";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    taskUuid: z.string().uuid(),
    confirm: z.boolean(),
  }),
  async (req, res) => {
    try {
      await resolveUnknownTask({
        taskUuid: req.body.taskUuid,
        confirm: req.body.confirm === true,
      });
      res.status(200).send(success({ resolved: true }));
    } catch (err) {
      const status = Number((err as { status?: unknown } | null)?.status ?? 400);
      const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 400;
      const domainCode = String((err as { code?: unknown } | null)?.code ?? "");
      const message = err instanceof Error ? err.message : "终结未知任务失败";
      if (/^[A-Z0-9_]{3,80}$/.test(domainCode)) {
        // 中文注释：并发状态冲突必须保留 HTTP 409 与领域 code，客户端才能安全刷新而不是盲目重试。
        res.status(safeStatus).send({ code: domainCode, data: null, message });
        return;
      }
      res.status(safeStatus).send(error(message, null, safeStatus));
    }
  },
);

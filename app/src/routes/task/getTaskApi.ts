import express from "express";
import { z } from "zod";

import { success, error } from "@/lib/responseFormat";
import { validateSchema } from "@/middleware/middleware";
import {
  TaskCenterError,
  taskCenterList,
} from "@/tianjiang/tasks/task-center-service";

const router = express.Router();

const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "projectUuid 无效",
  );

/** 任务列表请求契约：筛选优先 projectUuid；legacy projectId 仅兼容边界。 */
export const taskListRequestSchema = z.object({
  state: z.string().optional().nullable(),
  taskClass: z.string().optional().nullable(),
  projectUuid: z.preprocess(
    (value) => (value === "" || value == null ? null : value),
    uuidSchema.nullable().optional(),
  ),
  projectId: z.preprocess(
    (value) => (value === "" || value === null ? null : value),
    z.coerce.number().int().positive().nullable().optional(),
  ),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().default(10),
});

export default router.post(
  "/",
  validateSchema(taskListRequestSchema),
  async (req, res) => {
    try {
      const body = taskListRequestSchema.parse(req.body);
      const session = (req as { centralSession?: import("@/tianjiang/auth/central-session").CentralSession })
        .centralSession;
      const result = taskCenterList(session, {
        state: body.state,
        taskClass: body.taskClass,
        projectUuid: body.projectUuid ?? null,
        legacyProjectId: body.projectId ?? null,
        page: body.page,
        limit: body.limit,
      });
      res.status(200).send(success({ data: result.data, total: result.total }));
    } catch (caught) {
      if (caught instanceof TaskCenterError) {
        res.status(caught.status).send(error(caught.message));
        return;
      }
      if (caught instanceof z.ZodError) {
        const first = caught.issues?.[0]?.message;
        res.status(400).send(error(first ?? "请求无效"));
        return;
      }
      // 未分类异常可能含本机路径或数据库细节，统一对外收口。
      res.status(500).send(error("任务列表加载失败"));
    }
  },
);

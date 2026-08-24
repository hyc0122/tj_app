import express from "express";

import { success, error } from "@/lib/responseFormat";
import {
  TaskCenterError,
  taskCenterCategories,
} from "@/tianjiang/tasks/task-center-service";

const router = express.Router();

export default router.post("/", async (req, res) => {
  try {
    const session = (req as { centralSession?: import("@/tianjiang/auth/central-session").CentralSession })
      .centralSession;
    const data = taskCenterCategories(session);
    res.status(200).send(success(data));
  } catch (caught) {
    if (caught instanceof TaskCenterError) {
      res.status(caught.status).send(error(caught.message));
      return;
    }
    // 未分类异常可能含本机路径或数据库细节，统一对外收口。
    res.status(500).send(error("任务类别加载失败"));
  }
});

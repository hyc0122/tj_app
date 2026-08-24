import express from "express";
import { error } from "@/lib/responseFormat";

const router = express.Router();

export default router.get("/", async (_req, res) => {
  // 清库会破坏迁移版本、账号隔离和恢复证据，因此永久停用。
  res.status(410).send(error("数据库清空接口已停用"));
});

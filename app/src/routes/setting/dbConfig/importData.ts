import express from "express";
import { error } from "@/lib/responseFormat";

const router = express.Router();

export default router.post("/", async (_req, res) => {
  // 旧版导入先删全库且关闭外键，无法满足版本化迁移与原子回滚要求。
  res.status(410).send(error("数据库导入接口已停用"));
});

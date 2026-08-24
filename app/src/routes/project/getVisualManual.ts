import express from "express";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { loadVisualManuals } from "@/tianjiang/skills/project-manuals";

const router = express.Router();

/** 列出当前账号 art_skills 下的视觉手册卡片（封面/名称/stylePath）。 */
export default router.post("/", async (_req, res) => {
  try {
    const result = await loadVisualManuals(u.getPath());
    res.status(200).send(success(result));
  } catch (err) {
    // 错误信息不得包含本机绝对账号路径。
    const message = u.error(err).message || "视觉手册加载失败";
    res.status(503).send(error(message.replace(/[A-Za-z]:\\[^\s]+/g, "[path]")));
  }
});

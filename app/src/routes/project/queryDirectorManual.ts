import express from "express";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { loadDirectorManuals } from "@/tianjiang/skills/project-manuals";

const router = express.Router();

/** 列出当前账号 story_skills 下的导演手册卡片。 */
export default router.post("/", async (_req, res) => {
  try {
    const result = await loadDirectorManuals(u.getPath());
    res.status(200).send(success(result));
  } catch (err) {
    const message = u.error(err).message || "导演手册加载失败";
    res.status(503).send(error(message.replace(/[A-Za-z]:\\[^\s]+/g, "[path]")));
  }
});

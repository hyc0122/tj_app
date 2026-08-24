import express from "express";
import u from "@/utils";
import fs from "node:fs/promises";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { resolveManualStyleDirectory } from "@/tianjiang/skills/project-manuals";

const router = express.Router();

/** 删除当前账号下的视觉手册目录。 */
export default router.post(
  "/",
  validateFields({ name: z.string() }),
  async (req, res) => {
    try {
      const { name } = req.body as { name: string };
      if (name.includes("/") || name.includes("\\") || name === "." || name === ".." || /^\d+$/.test(name)) {
        res.status(400).send(error("名称不能包含路径分隔符或为纯数字"));
        return;
      }
      const { styleDir } = await resolveManualStyleDirectory(
        u.getPath(),
        "art_skills",
        name,
        { mustExist: true },
      );
      await fs.rm(styleDir, { recursive: true, force: true });
      res.status(200).send(success({ message: "删除成功" }));
    } catch (err) {
      const message = (u.error(err).message || "删除失败").replace(/[A-Za-z]:\\[^\s]+/g, "[path]");
      res.status(500).send(error(message));
    }
  },
);

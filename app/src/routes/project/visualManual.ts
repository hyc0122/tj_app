import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import fs from "fs";
import path from "path";
import {
  assertSafeSkillSegment,
  currentAccountSkillsRoot,
  resolveAccountSkillPath,
} from "@/tianjiang/skills/account-skills";

const router = express.Router();

/** 按类型读取当前账号内置风格 chinese_sweet_romance 下的 Markdown。 */
export default router.post(
  "/",
  validateFields({ type: z.string() }),
  async (req, res) => {
    try {
      const type = assertSafeSkillSegment(String(req.body.type), "手册字段");
      const skillsRoot = currentAccountSkillsRoot(u.getPath());
      const basePath = resolveAccountSkillPath(
        skillsRoot,
        path.posix.join("art_skills", "chinese_sweet_romance"),
        { kind: "directory", mustExist: true },
      );
      const findFile = (dir: string, target: string): string | null => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = findFile(fullPath, target);
            if (found) return found;
          } else if (entry.isFile() && entry.name === target) {
            return fullPath;
          }
        }
        return null;
      };
      const filePath = findFile(basePath, `${type}.md`);
      if (!filePath) {
        res.status(404).send(error(`未找到对应的文件: ${type}.md`));
        return;
      }
      res.status(200).send(success(fs.readFileSync(filePath, "utf-8")));
    } catch (err) {
      const message = u.error(err).message.replace(/[A-Za-z]:\\[^\s]+/g, "[path]");
      res.status(503).send(error(message));
    }
  },
);

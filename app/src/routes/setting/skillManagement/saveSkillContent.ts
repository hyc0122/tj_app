import express from "express";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import u from "@/utils";
import {
  ensureCurrentAccountBuiltinSkills,
  resolveAccountSkillFile,
} from "@/tianjiang/skills/account-skills";
import * as fs from "fs";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    path: z.string(),
    content: z.string(),
  }),
  async (req, res) => {
    const { path, content } = req.body;
    const { skillsRoot } = await ensureCurrentAccountBuiltinSkills(u.getPath());
    const filePath = resolveAccountSkillFile(skillsRoot, path, { mustExist: true });

    const raw = await fs.promises.writeFile(filePath, content, "utf-8");
    const { afterAccountSettingsWrite } = await import("@/tianjiang/sync/profile-settings-adapter");
    await afterAccountSettingsWrite();
    res.status(200).send(success(raw));
  },
);

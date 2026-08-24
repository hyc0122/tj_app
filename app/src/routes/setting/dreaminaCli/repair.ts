import express from "express";
import { z } from "zod";

import { error, success } from "@/lib/responseFormat";
import { validateSchema } from "@/middleware/middleware";
import { installDreaminaWithOfficialCommand } from "@/tianjiang/model-providers/dreamina-cli/official-command-installer";

const router = express.Router();

export default router.post(
  "/",
  validateSchema(z.object({ confirm: z.literal(true) }).strict()),
  async (_req, res) => {
    try {
      // 中文注释：修复与安装统一走官方 curl|bash，找不到 bash 时失败关闭，禁止回退旧下载器。
      const result = await installDreaminaWithOfficialCommand({ confirm: true });
      if (!result.ok) {
        return res.status(400).send(error(result.reason ?? "修复失败", result, 400));
      }
      return res.status(200).send(success(result));
    } catch (err) {
      return res.status(400).send(error(err instanceof Error ? err.message : "修复失败", null, 400));
    }
  },
);

import express from "express";
import { z } from "zod";

import { error, success } from "@/lib/responseFormat";
import { validateSchema } from "@/middleware/middleware";
import { installDreaminaWithOfficialCommand } from "@/tianjiang/model-providers/dreamina-cli/official-command-installer";

const router = express.Router();

export default router.post(
  "/",
  validateSchema(z.object({
    confirm: z.literal(true),
  }).strict()),
  async (req, res) => {
    try {
      const result = await installDreaminaWithOfficialCommand({ confirm: true });
      if (!result.ok) {
        return res.status(400).send(error(result.reason ?? "安装失败", result, 400));
      }
      return res.status(200).send(success(result));
    } catch (err) {
      return res.status(400).send(error(err instanceof Error ? err.message : "安装失败", null, 400));
    }
  },
);

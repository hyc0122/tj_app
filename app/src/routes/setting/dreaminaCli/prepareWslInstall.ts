import express from "express";
import { z } from "zod";

import { error, success } from "@/lib/responseFormat";
import { validateSchema } from "@/middleware/middleware";
import { prepareWslInstall } from "@/tianjiang/model-providers/dreamina-cli/wsl-manager";

const router = express.Router();

export default router.post(
  "/",
  validateSchema(z.object({ confirm: z.boolean() }).strict()),
  async (req, res) => {
    const result = await prepareWslInstall(req.body.confirm === true);
    if (!result.ok) return res.status(400).send(error(result.reason ?? "WSL 安装被拒绝", result, 400));
    return res.status(200).send(success(result));
  },
);

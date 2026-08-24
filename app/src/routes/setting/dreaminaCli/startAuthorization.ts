import express from "express";
import { z } from "zod";

import { error, success } from "@/lib/responseFormat";
import { validateSchema } from "@/middleware/middleware";
import {
  startDreaminaAuthorization,
  type DreaminaAuthorizationStartResult,
} from "@/tianjiang/model-providers/dreamina-cli/authorization-flow";

const router = express.Router();

export default router.post(
  "/",
  validateSchema(z.object({ confirm: z.literal(true) }).strict()),
  async (_req, res) => {
    try {
      const material: DreaminaAuthorizationStartResult = await startDreaminaAuthorization();
      return res.status(200).send(success(material));
    } catch (err) {
      return res.status(400).send(error(err instanceof Error ? err.message : "启动授权失败", null, 400));
    }
  },
);

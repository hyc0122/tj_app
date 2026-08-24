import express from "express";
import { z } from "zod";

import { error, success } from "@/lib/responseFormat";
import { validateSchema } from "@/middleware/middleware";
import { checkDreaminaAuthorization } from "@/tianjiang/model-providers/dreamina-cli/authorization-flow";

const router = express.Router();

export default router.post(
  "/",
  validateSchema(z.object({ authorizationId: z.string().min(1) }).strict()),
  async (req, res) => {
    try {
      const result = await checkDreaminaAuthorization(req.body.authorizationId);
      return res.status(200).send(success(result));
    } catch (err) {
      return res.status(400).send(error(err instanceof Error ? err.message : "查询授权失败", null, 400));
    }
  },
);

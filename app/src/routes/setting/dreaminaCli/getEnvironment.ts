import express from "express";

import { error, success } from "@/lib/responseFormat";
import { probeDreaminaEnvironment } from "@/tianjiang/model-providers/dreamina-cli/environment-probe";

const router = express.Router();

export default router.get("/", async (_req, res) => {
  try {
    const snapshot = await probeDreaminaEnvironment("windows_native");
    return res.status(200).send(success(snapshot));
  } catch (err) {
    return res.status(500).send(error(err instanceof Error ? err.message : "读取即梦环境失败", null, 500));
  }
});

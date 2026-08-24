import express from "express";

import { error, success } from "@/lib/responseFormat";
import { probeWslEnvironment } from "@/tianjiang/model-providers/dreamina-cli/wsl-manager";

const router = express.Router();

export default router.get("/", async (_req, res) => {
  try {
    return res.status(200).send(success(await probeWslEnvironment()));
  } catch (err) {
    return res.status(500).send(error(err instanceof Error ? err.message : "读取 WSL 状态失败", null, 500));
  }
});

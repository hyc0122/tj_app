import express from "express";

import { error, success } from "@/lib/responseFormat";
import { continueWslInstall } from "@/tianjiang/model-providers/dreamina-cli/wsl-manager";

const router = express.Router();

export default router.post("/", async (_req, res) => {
  try {
    return res.status(200).send(success(await continueWslInstall()));
  } catch (err) {
    return res.status(400).send(error(err instanceof Error ? err.message : "WSL 续办失败", null, 400));
  }
});

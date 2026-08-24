import express from "express";
import { centralAuthGateway } from "@/tianjiang/auth/auth-runtime";
import {
  centralServiceUnavailableResponse,
} from "@/tianjiang/auth/central-service-error";

const router = express.Router();

export default router.post("/", async (_req, res) => {
  try {
    const data = await centralAuthGateway.captcha();
    res.status(200).send({ code: 0, data, message: "验证码获取成功" });
  } catch (error) {
    const unavailable = centralServiceUnavailableResponse(error);
    if (unavailable) {
      return res.status(unavailable.status).send(unavailable.body);
    }
    res.status(502).send({ code: 502, message: "中央认证服务不可用" });
  }
});

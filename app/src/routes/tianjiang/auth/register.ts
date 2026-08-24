import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { centralAuthGateway } from "@/tianjiang/auth/auth-runtime";
import { CentralRequestError } from "@/tianjiang/auth/central-session";
import {
  centralServiceUnavailableResponse,
} from "@/tianjiang/auth/central-service-error";
import { evaluatePasswordPolicy } from "@/tianjiang/auth/password-policy";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    username: z.string().min(3).max(32),
    nickname: z.string().min(1).max(64),
    password: z.string().min(8).max(72),
    captcha: z.string().max(20),
    captchaId: z.string().max(200),
  }),
  async (req, res) => {
    try {
      const policy = evaluatePasswordPolicy(req.body.password);
      if (!policy.valid) {
        return res.status(422).send({
          code: "PASSWORD_POLICY",
          message: policy.message ?? "密码不符合安全规则",
        });
      }
      // 注册只转发固定业务字段，浏览器不能覆盖中央服务地址。
      await centralAuthGateway.register(req.body);
      res.status(200).send({ code: 0, data: {}, message: "注册申请已受理，请返回登录" });
    } catch (error) {
      const unavailable = centralServiceUnavailableResponse(error);
      if (unavailable) {
        return res.status(unavailable.status).send(unavailable.body);
      }
      if (error instanceof CentralRequestError) {
        // 只透传网关审查后的公开字段，禁止序列化请求编号、堆栈或内部地址。
        return res.status(error.status).send({
          code: error.code,
          message: error.message,
        });
      }
      // 未知异常继续使用固定消息，避免把内部实现细节透传给浏览器。
      res.status(400).send({ code: 400, message: "注册申请未受理，请检查填写内容" });
    }
  },
);

import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import {
  authCredentialStore,
  centralAuthGateway,
  centralSessionStore,
} from "@/tianjiang/auth/auth-runtime";
import {
  CentralRequestError,
  clearSessionCookie,
  type CentralSession,
} from "@/tianjiang/auth/central-session";
import { centralServiceUnavailableResponse } from "@/tianjiang/auth/central-service-error";
import { evaluatePasswordPolicy } from "@/tianjiang/auth/password-policy";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    oldPassword: z.string().min(8).max(72),
    newPassword: z.string().min(8).max(72),
  }),
  async (req, res) => {
    const session = (req as express.Request & { centralSession: CentralSession }).centralSession;
    const policy = evaluatePasswordPolicy(req.body.newPassword);
    if (!policy.valid) {
      return res.status(422).send({ code: "PASSWORD_POLICY", message: policy.message ?? "密码不符合安全规则" });
    }
    try {
      const result = await centralAuthGateway.changePassword(session, req.body);
      try {
        authCredentialStore.updateAfterPasswordChange(result.user.username, req.body.newPassword, {
          serverUrl: result.session.serverUrl,
          token: result.session.token,
          expiresAt: result.session.expiresAt,
          user: result.user,
        });
      } catch {
        // 中文注释：密码已在中央端改变但本地安全存储失败时，立即撤销本地会话并要求重新认证。
        centralSessionStore.delete(session.id);
        res.setHeader("Set-Cookie", clearSessionCookie(req.secure));
        return res.status(409).send({
          code: "LOCAL_CREDENTIAL_COMMIT_FAILED",
          message: "密码已更新，请使用新密码重新登录",
        });
      }
      Object.assign(session, result.session);
      const user = result.user;
      return res.status(200).send({ code: 0, data: { user }, message: "密码修改成功" });
    } catch (error) {
      const unavailable = centralServiceUnavailableResponse(error);
      if (unavailable) return res.status(unavailable.status).send(unavailable.body);
      if (error instanceof CentralRequestError) {
        return res.status(error.status).send({ code: error.code, message: error.message });
      }
      return res.status(400).send({ code: 400, message: "密码修改失败" });
    }
  },
);

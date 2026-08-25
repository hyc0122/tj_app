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

const router = express.Router();

function currentSession(req: express.Request): CentralSession {
  return (req as express.Request & { centralSession: CentralSession }).centralSession;
}

router.get("/", (req, res) => {
  res.status(200).send({ code: 0, data: { user: currentSession(req).user }, message: "个人资料获取成功" });
});

router.patch(
  "/",
  validateFields({
    username: z.string().regex(/^[a-z0-9][a-z0-9_.-]{2,31}$/),
    nickname: z.string().trim().min(1).max(64),
  }),
  async (req, res) => {
    const session = currentSession(req);
    const previousUsername = session.user.username;
    try {
      const result = await centralAuthGateway.updateProfile(session, req.body);
      try {
        authCredentialStore.updateAfterProfileChange(previousUsername, {
          serverUrl: result.session.serverUrl,
          token: result.session.token,
          expiresAt: result.session.expiresAt,
          user: result.user,
        });
      } catch {
        // 中文注释：中央端已经轮换令牌但本地原子凭据提交失败时，禁止继续使用半旧会话。
        centralSessionStore.delete(session.id);
        res.setHeader("Set-Cookie", clearSessionCookie(req.secure));
        return res.status(409).send({
          code: "LOCAL_CREDENTIAL_COMMIT_FAILED",
          message: "个人资料已更新，请重新登录以恢复本地凭据",
        });
      }
      Object.assign(session, result.session);
      const user = result.user;
      res.status(200).send({ code: 0, data: { user }, message: "个人资料修改成功" });
    } catch (error) {
      const unavailable = centralServiceUnavailableResponse(error);
      if (unavailable) return res.status(unavailable.status).send(unavailable.body);
      if (error instanceof CentralRequestError) {
        return res.status(error.status).send({ code: error.code, message: error.message });
      }
      return res.status(400).send({ code: 400, message: "个人资料修改失败" });
    }
  },
);

export default router;

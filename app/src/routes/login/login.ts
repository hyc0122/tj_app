import express from "express";
const router = express.Router();

// 旧本地账号登录已永久关闭，防止 o_user 绕过中央账号、状态和 Casbin。
export default router.all("/", (_req, res) => {
  res.status(410).send({ code: 410, message: "旧本地登录已停用，请使用中央登录" });
});

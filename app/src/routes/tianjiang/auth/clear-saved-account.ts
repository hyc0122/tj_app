import express from "express";
import { authCredentialStore } from "@/tianjiang/auth/auth-runtime";

const router = express.Router();

/** 清除已保存账号：token、用户名、密码全部删除。 */
export default router.post("/", (_req, res) => {
  authCredentialStore.clearAllSavedAccounts();
  res.status(200).send({ code: 0, data: null, message: "已清除保存的账号" });
});

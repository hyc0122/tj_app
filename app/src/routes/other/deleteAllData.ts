import express from "express";
import { error } from "@/lib/responseFormat";
const router = express.Router();

// 旧版全库重建会绕过版本迁移和备份门，生产路由永久失败关闭。
export default router.post(
    "/",
    async (_req, res) => {
        res.status(410).send(error("全库重建接口已停用"));
    },
);

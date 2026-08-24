import express from "express";
import { success, error } from "@/lib/responseFormat";
import {
  parseManualUpdateActionBody,
  type ManualUpdateActionBody,
} from "@/tianjiang/update/manual-update-contracts";

const router = express.Router();

type UpdaterLike = {
  getSnapshot: () => unknown;
  runAction: (body: ManualUpdateActionBody) => Promise<unknown>;
};

let updater: UpdaterLike | null = null;

export function bindManualDownloadUpdater(next: UpdaterLike | null): void {
  updater = next;
}

/**
 * 用户确认后下载/安装；严禁 ZIP 解压到 userData。
 * body: 下载动作必须携带 channel；install/show-file 只作用于主进程当前已验证候选。
 */
export default router.post("/", async (req, res) => {
  try {
    const body = parseManualUpdateActionBody(req.body);
    if (body.action === "check" || body.action === "check-login-stable") {
      return res.status(400).send(error("下载路由不接受 check 动作"));
    }
    if (!updater) {
      return res.status(503).send(error("更新服务未就绪"));
    }
    const snapshot = await updater.runAction(body);
    res.status(200).send(success(snapshot));
  } catch (err) {
    res.status(400).send(error(err instanceof Error ? err.message : "更新动作无效"));
  }
});

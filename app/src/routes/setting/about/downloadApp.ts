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
  startAction: (body: ManualUpdateActionBody) => Promise<unknown>;
};

let updater: UpdaterLike | null = null;

export function bindManualDownloadUpdater(next: UpdaterLike | null): void {
  updater = next;
}

/**
 * 用户确认后下载/安装；严禁 ZIP 解压到 userData。
 * body: 下载动作必须携带 channel；install/show-file 只作用于主进程当前已验证候选。
 */
router.get("/", (_req, res) => {
  if (!updater) return res.status(503).send(error("更新服务未就绪"));
  return res.status(200).send(success(updater.getSnapshot()));
});

router.post("/", async (req, res) => {
  try {
    const body = parseManualUpdateActionBody(req.body);
    if (body.action === "check" || body.action === "check-login-stable") {
      return res.status(400).send(error("下载路由不接受 check 动作"));
    }
    if (!updater) {
      return res.status(503).send(error("更新服务未就绪"));
    }
    if (
      body.action === "download-differential"
      || body.action === "download-full"
      || body.action === "install"
    ) {
      // 中文注释：下载和安装均只受理后台动作，先结束本地 HTTP 请求，再进入下载或退出门。
      const snapshot = await updater.startAction(body);
      return res.status(202).send(success(snapshot));
    }
    const snapshot = await updater.runAction(body);
    return res.status(200).send(success(snapshot));
  } catch (err) {
    res.status(400).send(error(err instanceof Error ? err.message : "更新动作无效"));
  }
});

export default router;

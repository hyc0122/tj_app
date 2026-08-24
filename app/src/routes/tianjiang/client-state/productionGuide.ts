import express from "express";

import u from "@/utils";
import { getStableDeviceUUID } from "@/tianjiang/auth/device";
import { putGuideStateBodySchema } from "@/tianjiang/client-state/contracts";
import { OnboardingStore } from "@/tianjiang/client-state/onboarding-store";

const PRODUCTION_GUIDE_ID = "production" as const;

type ProductionGuideRouterDependencies = {
  dataRoot?: string;
  deviceUuid?: () => string;
};

function sessionUser(req: express.Request): { id: number } | null {
  const user = (req as express.Request & { user?: { id?: number } }).user
    ?? (req as express.Request & { centralSession?: { user?: { id?: number } } }).centralSession?.user;
  if (!user || typeof user.id !== "number") return null;
  return { id: user.id };
}

/**
 * 视频生产引导使用 App 稳定目录持久化，避免 renderer 随机端口改变 localStorage origin。
 */
export function createProductionGuideRouter(
  dependencies: ProductionGuideRouterDependencies = {},
): express.Router {
  const router = express.Router();
  const dataRoot = dependencies.dataRoot ?? u.getPath();
  const store = new OnboardingStore(dataRoot);
  const readDeviceUuid = dependencies.deviceUuid
    ?? (() => getStableDeviceUUID(dataRoot));

  router.get("/", (req, res) => {
    const user = sessionUser(req);
    if (!user) {
      return res.status(401).send({ code: 401, message: "需要登录" });
    }
    try {
      const deviceUuid = readDeviceUuid();
      const state = store.getGuide(PRODUCTION_GUIDE_ID, user.id, deviceUuid);
      return res.status(200).send({
        code: 0,
        data: state ?? {
          guideId: PRODUCTION_GUIDE_ID,
          businessUserId: user.id,
          deviceUuid,
          completedRevision: 0,
          completedAt: "",
        },
        message: "ok",
      });
    } catch {
      return res.status(500).send({
        code: "PRODUCTION_GUIDE_STATE_READ_FAILED",
        message: "新手引导状态读取失败，请稍后重试",
      });
    }
  });

  router.put("/", (req, res) => {
    const user = sessionUser(req);
    if (!user) {
      return res.status(401).send({ code: 401, message: "需要登录" });
    }
    const parsed = putGuideStateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).send({
        code: "PRODUCTION_GUIDE_REQUEST_INVALID",
        message: "请求无效",
      });
    }
    try {
      const deviceUuid = readDeviceUuid();
      // 中文注释：renderer 不得控制业务账号或设备身份，只提交完成版本。
      const state = store.putGuide(
        PRODUCTION_GUIDE_ID,
        user.id,
        deviceUuid,
        parsed.data.completedRevision,
      );
      return res.status(200).send({
        code: 0,
        data: state,
        message: "新手引导状态已保存",
      });
    } catch {
      return res.status(500).send({
        code: "PRODUCTION_GUIDE_STATE_SAVE_FAILED",
        message: "新手引导状态保存失败，请稍后重试",
      });
    }
  });

  return router;
}

export default createProductionGuideRouter();

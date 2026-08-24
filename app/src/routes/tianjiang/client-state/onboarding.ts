import express from "express";
import u from "@/utils";
import { getStableDeviceUUID } from "@/tianjiang/auth/device";
import { parsePutOnboardingBody } from "@/tianjiang/client-state/contracts";
import { OnboardingStore } from "@/tianjiang/client-state/onboarding-store";

const router = express.Router();
const store = new OnboardingStore(u.getPath());

function sessionUser(req: express.Request): { id: number } | null {
  const user = (req as express.Request & { user?: { id?: number } }).user
    ?? (req as express.Request & { centralSession?: { user?: { id?: number } } }).centralSession?.user;
  if (!user || typeof user.id !== "number") return null;
  return { id: user.id };
}

function deviceUuid(): string {
  return getStableDeviceUUID(u.getPath());
}

router.get("/", (req, res) => {
  const user = sessionUser(req);
  if (!user) {
    return res.status(401).send({ code: 401, message: "需要登录" });
  }
  const device = deviceUuid();
  const state = store.get(user.id, device);
  res.status(200).send({
    code: 0,
    data: state ?? {
      businessUserId: user.id,
      deviceUuid: device,
      completedRevision: 0,
      completedAt: "",
    },
    message: "ok",
  });
});

router.put("/", (req, res) => {
  const user = sessionUser(req);
  if (!user) {
    return res.status(401).send({ code: 401, message: "需要登录" });
  }
  try {
    const body = parsePutOnboardingBody(req.body);
    const device = deviceUuid();
    // renderer 不得提交 userId/deviceUuid，由会话与本机设备上下文写入。
    const state = store.put(user.id, device, body.completedRevision);
    res.status(200).send({ code: 0, data: state, message: "引导状态已保存" });
  } catch (error) {
    res.status(400).send({
      code: 400,
      message: error instanceof Error ? error.message : "请求无效",
    });
  }
});

export default router;

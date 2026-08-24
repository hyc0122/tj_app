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

export type ManualUpdaterBindingState =
  | { state: "initializing"; platform: string; arch: string; currentVersion: string }
  | { state: "failed"; platform: string; arch: string; currentVersion: string; message?: string }
  | { state: "unsupported"; platform: string; arch: string; currentVersion: string };

let bindingState: ManualUpdaterBindingState | null = null;

export function bindManualUpdater(next: UpdaterLike | null, state?: ManualUpdaterBindingState): void {
  updater = next;
  if (!next) {
    // 中文注释：未绑定服务时必须由主进程显式给出 app.getVersion()，禁止在服务端猜包版本。
    if (!state) throw new Error("更新服务未绑定状态必须包含主进程版本");
    bindingState = state;
  }
}

function unavailableSnapshot(loginAllowed: boolean) {
  const unsupported = bindingState?.state === "unsupported";
  const channel = {
    status: unsupported ? "unsupported" : "error",
    source: "none",
    required: false,
    downloadAllowed: false,
    errorCode: unsupported ? "PLATFORM_UNSUPPORTED" : "UPDATE_SERVICE_NOT_READY",
  };
  return {
    state: unsupported ? "unsupported" : "error",
    currentVersion: bindingState?.currentVersion ?? null,
    stable: channel,
    beta: { ...channel },
    stableRequired: false,
    loginAllowed,
    selectedChannel: null,
    warningMessage: unsupported
      ? `当前平台 ${bindingState!.platform}/${bindingState!.arch} 不支持 Windows x64 桌面更新`
      : undefined,
  };
}

/**
 * 手动更新检查入口：body 只允许 action，禁止 url/feedBaseUrl。
 */
export default router.post("/", async (req, res) => {
  try {
    const body = parseManualUpdateActionBody(req.body);
    if (body.action !== "check" && body.action !== "check-login-stable") {
      return res.status(400).send(error("检查路由只接受 check 动作"));
    }
    if (!updater) {
      if (bindingState?.state === "unsupported") {
        return res.status(200).send(success(unavailableSnapshot(true)));
      }
      // 中文注释：受支持平台未绑定或初始化失败时必须阻断登录，renderer 只能明确重试。
      const message = bindingState?.state === "failed"
        ? "更新服务初始化失败，请稍后重试"
        : "更新服务初始化未就绪，请稍后重试";
      return res.status(503).send(error(message, unavailableSnapshot(false), 503));
    }
    const snapshot = await updater.runAction(body);
    res.status(200).send(success(snapshot));
  } catch (err) {
    if (req.body?.action === "check-login-stable") {
      const current = updater?.getSnapshot();
      const failClosed = current && typeof current === "object"
        ? { ...(current as Record<string, unknown>), state: "error", loginAllowed: false }
        : unavailableSnapshot(false);
      return res.status(503).send(error(
        "正式版更新检查未完成，请稍后重试",
        failClosed,
        503,
      ));
    }
    res.status(400).send(error(err instanceof Error ? err.message : "更新请求无效"));
  }
});

import axios from "@/utils/axios";

export type TianjiangUpdateChannel = "stable" | "beta";
export type TianjiangUpdateState =
  | "idle"
  | "unsupported"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export interface TianjiangUpdateChannelSnapshot {
  status: "idle" | "unsupported" | "checking" | "available" | "current" | "error";
  source: "network" | "cache" | "none";
  latestVersion?: string;
  sourceChannel?: TianjiangUpdateChannel;
  packageSizeBytes?: number;
  required: boolean;
  downloadAllowed: boolean;
  errorCode?: string;
}

export interface TianjiangUpdateSnapshot {
  state: TianjiangUpdateState;
  currentVersion: string;
  stable: TianjiangUpdateChannelSnapshot;
  beta: TianjiangUpdateChannelSnapshot;
  stableRequired: boolean;
  loginAllowed: boolean;
  selectedChannel: TianjiangUpdateChannel | null;
  latestVersion?: string;
  releaseNotes?: string;
  packageSizeBytes?: number;
  progress?: number;
  errorMessage?: string;
  warningMessage?: string;
  downloadedPath?: string;
  channel?: TianjiangUpdateChannel;
}

export type TianjiangDownloadAction = "download-differential" | "download-full";
export type TianjiangLocalAction = "install" | "show-file";

function unwrapSnapshot(response: unknown): TianjiangUpdateSnapshot {
  const envelope = response as { data?: unknown } | null;
  return (envelope?.data ?? response) as TianjiangUpdateSnapshot;
}

/** Renderer 只提交冻结动作；URL、feed 与文件路径始终由主进程决定。 */
export async function checkTianjiangUpdate(
  action: "check" | "check-login-stable",
): Promise<TianjiangUpdateSnapshot> {
  return unwrapSnapshot(await axios.post("/setting/about/checkUpdate", { action }));
}

export async function downloadTianjiangUpdate(
  action: TianjiangDownloadAction,
  channel: TianjiangUpdateChannel,
): Promise<TianjiangUpdateSnapshot> {
  return unwrapSnapshot(await axios.post("/setting/about/downloadApp", { action, channel }));
}

export async function runTianjiangLocalUpdateAction(
  action: TianjiangLocalAction,
): Promise<TianjiangUpdateSnapshot> {
  return unwrapSnapshot(await axios.post("/setting/about/downloadApp", { action }));
}

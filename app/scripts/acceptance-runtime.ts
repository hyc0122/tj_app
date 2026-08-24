export interface AcceptanceRuntimeSnapshotInput {
  acceptanceMode: boolean;
  userData: string;
  trayReady: boolean;
}

/**
 * 运行时验收信号只公开受控 profile 路径和托盘对象是否真实存在，不返回账号或凭据。
 */
export function buildAcceptanceRuntimeSnapshot(
  input: AcceptanceRuntimeSnapshotInput,
): AcceptanceRuntimeSnapshotInput {
  if (!input.acceptanceMode) {
    throw new Error("运行时验收信号只允许显式验收模式读取");
  }
  if (!input.userData) throw new Error("运行时验收 userData 不可用");
  return {
    acceptanceMode: true,
    userData: input.userData,
    trayReady: input.trayReady,
  };
}

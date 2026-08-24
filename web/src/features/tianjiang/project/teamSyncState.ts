export interface TeamSyncPresentation {
  editable: boolean;
  readonlyReason: string;
  lockHolder: string;
  recoveryRequired: boolean;
}

const readonlyLabels: Record<string, string> = {
  viewer_role: "当前角色仅可查看",
  locked_by_other: "项目正在由其他成员编辑",
  network_disconnected: "网络中断，已切换只读",
  session_invalid: "登录会话失效，已切换只读",
  lease_expired: "编辑锁已过期，已切换只读",
};

export function describeTeamSync(state: TeamSyncPresentation): {
  badge: "可编辑" | "只读";
  detail: string;
  showRecovery: boolean;
} {
  return {
    badge: state.editable ? "可编辑" : "只读",
    detail: state.editable
      ? "已取得团队编辑锁"
      : `${readonlyLabels[state.readonlyReason] ?? "当前项目只读"}${state.lockHolder ? `：${state.lockHolder}` : ""}`,
    showRecovery: state.recoveryRequired,
  };
}

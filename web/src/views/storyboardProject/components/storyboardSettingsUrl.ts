export function buildStoryboardSettingsUrl(projectUuid?: string): string {
  // 项目身份缺失时禁止构造模糊地址，避免请求落到错误项目。
  if (!projectUuid) {
    throw new Error("分镜设置缺少项目身份");
  }
  return `/tianjiang/runtime/projects/${encodeURIComponent(projectUuid)}/storyboard/settings`;
}

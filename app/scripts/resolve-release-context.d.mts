export interface ReleaseContext {
  version: string;
  tag: string;
  channel: "beta";
  prerelease: true;
}

/** 根据 Git 引用与 package.json 版本冻结唯一 Beta 发布上下文。 */
export function resolveReleaseContext(
  refType: string,
  refName: string,
  packageVersion: string,
): ReleaseContext;

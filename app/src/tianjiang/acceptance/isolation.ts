import fs from "node:fs";
import path from "node:path";

export const ACCEPTANCE_MODE_ENV = "TIANJIANG_ACCEPTANCE_MODE";
export const ACCEPTANCE_USER_DATA_ENV = "TIANJIANG_ACCEPTANCE_USER_DATA_DIR";
export const ACCEPTANCE_CENTRAL_API_ENV = "TIANJIANG_ACCEPTANCE_CENTRAL_API_URL";

interface ElectronPathController {
  setPath(name: "userData", value: string): void;
}

export function isAcceptanceMode(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment[ACCEPTANCE_MODE_ENV] === "1";
}

/**
 * 打包验收必须解析到当前工作树 .local\\profile，禁止用安装目录旁的 profile
 * 或 Electron --user-data-dir 冒充业务隔离。
 */
export function resolveAcceptanceProfileRoot(input: {
  isPackaged: boolean;
  resourcesPath: string;
  cwd: string;
}): string {
  if (!input.isPackaged) {
    return path.resolve(input.cwd, "..", ".local", "profile");
  }
  let current = path.resolve(input.resourcesPath);
  for (let hop = 0; hop < 8; hop += 1) {
    const parent = path.dirname(current);
    if (parent === current) break;
    const candidate = path.join(parent, ".local", "profile");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    current = parent;
  }
  throw new Error("打包验收找不到当前工作树 .local\\profile");
}

/**
 * 只在显式验收模式下设置 Electron userData。
 * 校验过程不调用 app.getPath，也不创建目录，避免在 setPath 前触碰真实 AppData。
 */
export function applyAcceptanceUserDataPath(
  app: ElectronPathController,
  allowedProfileRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!isAcceptanceMode(environment)) return undefined;

  const rawCandidate = environment[ACCEPTANCE_USER_DATA_ENV];
  if (!rawCandidate) {
    throw new Error("验收模式缺少 userData 隔离路径");
  }
  const candidate = validateLocalAcceptancePath(
    rawCandidate,
    allowedProfileRoot,
    "验收 userData 路径",
  );
  app.setPath("userData", candidate);
  return candidate;
}

/**
 * 验收中央地址必须显式提供；正常生产调用方不会读取这个变量。
 */
export function acceptanceCentralApiUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!isAcceptanceMode(environment)) return undefined;
  const value = environment[ACCEPTANCE_CENTRAL_API_ENV];
  if (!value) throw new Error("验收模式缺少中央 API URL");
  return value;
}

function validateLocalAcceptancePath(
  rawCandidate: string,
  rawAllowedRoot: string,
  label: string,
): string {
  const candidate = path.win32.resolve(rawCandidate);
  const allowedRoot = path.win32.resolve(rawAllowedRoot);
  const localRoot = path.win32.dirname(allowedRoot);
  const workspaceRoot = path.win32.dirname(localRoot);
  const expectedAllowedRoot = path.win32.join(workspaceRoot, ".local", "profile");
  if (
    path.win32.basename(allowedRoot).toLowerCase() !== "profile"
    || path.win32.basename(localRoot).toLowerCase() !== ".local"
    || !sameWindowsPath(allowedRoot, expectedAllowedRoot)
  ) {
    throw new Error("验收 profile 根目录必须是当前工作树 .local\\profile");
  }

  const workspaceDrive = assertLocalWorktreePath(
    workspaceRoot,
    path.win32.parse(workspaceRoot).root,
    "当前工作树",
  );
  // 必须在 resolve 前检查调用方原始串，禁止相对路径被规范化成允许目录。
  assertLocalWorktreePath(rawAllowedRoot, workspaceDrive, "验收 profile 根目录");
  assertLocalWorktreePath(rawCandidate, workspaceDrive, label);
  assertInside(workspaceRoot, allowedRoot, "验收 profile 根目录必须位于当前工作树内");
  assertStrictDescendant(
    allowedRoot,
    candidate,
    `${label}必须位于 .local\\profile 的子目录内，不能直接使用允许根`,
  );

  // Windows 的 lstat 会把符号链接和 Junction reparse point 标记为 symbolic link。
  // 必须从盘符根逐级检查，不能先跟随 stat/realpath 后再把解析结果当信任根。
  assertPathChainHasNoReparsePoints(allowedRoot, "验收 profile 根目录");
  assertPathChainHasNoReparsePoints(candidate, label);

  const realWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  const realAllowedRoot = fs.realpathSync.native(allowedRoot);
  const realCandidate = fs.realpathSync.native(candidate);

  // 真实路径必须重新走完整的本机绝对路径、同盘、非 C 盘和工作树边界校验。
  const realWorkspaceDrive = assertLocalWorktreePath(
    realWorkspaceRoot,
    workspaceDrive,
    "解析后的当前工作树",
  );
  assertLocalWorktreePath(
    realAllowedRoot,
    realWorkspaceDrive,
    "解析后的验收 profile 根目录",
  );
  assertLocalWorktreePath(realCandidate, realWorkspaceDrive, `解析后的${label}`);
  assertInside(
    realWorkspaceRoot,
    realAllowedRoot,
    "解析后的验收 profile 根目录越过当前工作树",
  );
  const expectedRealAllowedRoot = path.win32.join(
    realWorkspaceRoot,
    ".local",
    "profile",
  );
  if (!sameWindowsPath(realAllowedRoot, expectedRealAllowedRoot)) {
    throw new Error("解析后的验收 profile 根目录不是当前工作树 .local\\profile");
  }
  assertStrictDescendant(
    realAllowedRoot,
    realCandidate,
    `解析后的${label}越过验收 profile 根目录或直接使用允许根`,
  );
  return candidate;
}

function assertLocalWorktreePath(
  rawPath: string,
  expectedDrive: string,
  label: string,
): string {
  if (
    rawPath.startsWith("\\\\")
    || rawPath.startsWith("//")
    || /^[\\/]{2}[?.][\\/]/.test(rawPath)
    || !path.win32.isAbsolute(rawPath)
  ) {
    throw new Error(`${label}必须是本机绝对路径`);
  }

  const drive = path.win32.parse(path.win32.resolve(rawPath)).root.toLowerCase();
  const normalizedExpectedDrive = path.win32.parse(expectedDrive).root.toLowerCase();
  if (
    !/^[a-z]:\\$/.test(drive)
    || drive === "c:\\"
    || drive !== normalizedExpectedDrive
  ) {
    throw new Error(`${label}必须位于当前工作树所在的本机非 C 盘`);
  }
  return drive;
}

function assertPathChainHasNoReparsePoints(
  targetPath: string,
  label: string,
): void {
  const resolved = path.win32.resolve(targetPath);
  const parsed = path.win32.parse(resolved);
  let current = parsed.root;
  const components = resolved
    .slice(parsed.root.length)
    .split(path.win32.sep)
    .filter(Boolean);

  for (const component of components) {
    current = path.win32.join(current, component);
    let details: fs.Stats;
    try {
      details = fs.lstatSync(current);
    } catch {
      throw new Error(`${label}路径组成部分不存在：${current}`);
    }
    if (details.isSymbolicLink()) {
      throw new Error(`${label}禁止包含符号链接、Junction 或 reparse point`);
    }
    if (!details.isDirectory()) {
      throw new Error(`${label}必须是已经存在的目录`);
    }

    // 额外比较逐级真实路径，拒绝未被 isSymbolicLink 暴露但会重定向的 reparse point。
    const realCurrent = fs.realpathSync.native(current);
    if (!sameWindowsPath(current, realCurrent)) {
      throw new Error(`${label}禁止包含重定向 reparse point`);
    }
  }
}

function assertInside(root: string, target: string, message: string): void {
  const relative = path.win32.relative(root, target);
  if (
    relative === ".."
    || relative.startsWith(`..${path.win32.sep}`)
    || path.win32.isAbsolute(relative)
  ) {
    throw new Error(message);
  }
}

function assertStrictDescendant(
  root: string,
  target: string,
  message: string,
): void {
  const relative = path.win32.relative(root, target);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.win32.sep}`)
    || path.win32.isAbsolute(relative)
  ) {
    throw new Error(message);
  }
}

function sameWindowsPath(left: string, right: string): boolean {
  return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}

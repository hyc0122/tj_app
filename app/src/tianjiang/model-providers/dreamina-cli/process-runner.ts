import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import isPathInside from "is-path-inside";

import { DREAMINA_ERROR, DREAMINA_MODES, type DreaminaMode } from "./contracts";
import { assertManagedPathChainHasNoLinks } from "@/tianjiang/media/project-file-store";

const OUTPUT_LIMIT = 64 * 1024;
const TEST_FIXTURE_EXECUTABLE = path.resolve(
  __dirname,
  "../../../../test/tianjiang/fixtures/fake-dreamina-cli.cjs",
);
const DEFAULT_TIMEOUTS = {
  probe: 15_000,
  submit: 45_000,
  query: 30_000,
  download: 120_000,
  credit: 15_000,
  session: 20_000,
  logout: 15_000,
} as const;

const ALLOWED_COMMANDS = new Set([
  "version",
  "-h",
  "--help",
  "user_credit",
  "session",
  "query_result",
  "list_task",
  "logout",
  "login",
  ...DREAMINA_MODES,
]);

export class DreaminaProcessError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export interface DreaminaRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  parsed: Record<string, unknown> | null;
}

export type DreaminaTimeoutKind = keyof typeof DEFAULT_TIMEOUTS;

function testTimeoutOverride(): number | undefined {
  if (!process.env.NODE_TEST_CONTEXT) return undefined;
  const raw = process.env.DREAMINA_CLI_TIMEOUT_MS;
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function timeoutFor(kind: DreaminaTimeoutKind): number {
  return testTimeoutOverride() ?? DEFAULT_TIMEOUTS[kind];
}

export function resolveSpawnInvocation(executablePath: string): { file: string; argsPrefix: string[] } {
  const resolved = path.resolve(executablePath);
  if (/\.(cjs|mjs|js)$/i.test(resolved)) {
    return { file: process.execPath, argsPrefix: [resolved] };
  }
  return { file: resolved, argsPrefix: [] };
}

export function assertSafeExecutable(executablePath: string): string {
  // 中文注释：受控安装先在 installer 校验官方 URL/SHA-256/PE 架构，这里只允许本地已存在的普通文件。
  if (!executablePath || !executablePath.trim()) {
    throw new DreaminaProcessError(DREAMINA_ERROR.notInstalled, "未配置即梦 CLI 可执行文件", false);
  }
  if (isUncPath(executablePath)) {
    throw new DreaminaProcessError(DREAMINA_ERROR.pathRejected, "可执行路径不能是 UNC 网络路径", false);
  }
  const resolved = path.resolve(executablePath);
  if (!fs.existsSync(resolved)) {
    throw new DreaminaProcessError(DREAMINA_ERROR.notInstalled, "即梦 CLI 可执行文件不存在", false);
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) {
    throw new DreaminaProcessError(DREAMINA_ERROR.pathRejected, "拒绝通过符号链接调用即梦 CLI", false);
  }
  if (!stat.isFile()) {
    throw new DreaminaProcessError(DREAMINA_ERROR.notInstalled, "即梦 CLI 路径不是可执行文件", false);
  }
  assertTestFixtureExecutable(resolved);
  return resolved;
}

function assertTestFixtureExecutable(executablePath: string): void {
  if (!process.env.NODE_TEST_CONTEXT) return;

  // 中文注释：测试进程只能拉起仓库内唯一受控 fixture；显式外部路径、账号配置和 PATH 回退统一在 spawn 前熔断。
  let canonicalExecutable: string;
  let canonicalFixture: string;
  try {
    canonicalExecutable = fs.realpathSync.native(executablePath);
    canonicalFixture = fs.realpathSync.native(TEST_FIXTURE_EXECUTABLE);
  } catch {
    throw new DreaminaProcessError(
      DREAMINA_ERROR.pathRejected,
      "测试环境只允许仓库内固定即梦 CLI fixture",
      false,
    );
  }
  const normalize = (value: string) => process.platform === "win32"
    ? value.toLocaleLowerCase("en-US")
    : value;
  if (normalize(canonicalExecutable) !== normalize(canonicalFixture)) {
    throw new DreaminaProcessError(
      DREAMINA_ERROR.pathRejected,
      "测试环境禁止调用真实或外部即梦 CLI",
      false,
    );
  }
}

export function findDreaminaInSafePath(): string | null {
  const parts = String(process.env.PATH || "").split(path.delimiter);
  const names = process.platform === "win32"
    ? ["dreamina.exe", "dreamina.cmd", "dreamina"]
    : ["dreamina"];
  for (const dir of parts) {
    if (!dir || isUncPath(dir)) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        const stat = fs.lstatSync(candidate);
        if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
      } catch {
        // 该 PATH 项不存在时继续。
      }
    }
  }
  return null;
}

export function assertManagedFilePath(filePath: string, roots: readonly string[]): string {
  if (!filePath || !filePath.trim()) {
    throw new DreaminaProcessError(DREAMINA_ERROR.pathRejected, "缺少受管文件路径", false);
  }
  if (isUncPath(filePath)) {
    throw new DreaminaProcessError(DREAMINA_ERROR.pathRejected, "拒绝 UNC 非受管路径", false);
  }
  if (/[\n\r\0]/.test(filePath)) {
    throw new DreaminaProcessError(DREAMINA_ERROR.pathRejected, "文件路径包含非法控制字符", false);
  }
  const resolved = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new DreaminaProcessError(DREAMINA_ERROR.pathRejected, "参考文件不存在或不在受管目录", false);
  }
  if (stat.isSymbolicLink()) {
    throw new DreaminaProcessError(DREAMINA_ERROR.pathRejected, "拒绝符号链接参考文件", false);
  }
  const allowedRoot = roots.find((root) => {
    const normalized = path.resolve(root);
    return resolved === normalized || isPathInside(resolved, normalized);
  });
  if (!allowedRoot) {
    throw new DreaminaProcessError(DREAMINA_ERROR.pathRejected, "文件必须位于项目受管目录或任务暂存目录", false);
  }
  try {
    // 中文注释：spawn 前重新验证原始父链，不能让 staging junction 通过词法包含检查。
    assertManagedPathChainHasNoLinks(allowedRoot, resolved);
  } catch {
    throw new DreaminaProcessError(DREAMINA_ERROR.pathRejected, "参考文件路径链不安全", false);
  }
  return resolved;
}

export function buildAllowedArgs(command: string, extra: readonly string[] = []): string[] {
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new DreaminaProcessError(DREAMINA_ERROR.commandRejected, "拒绝执行未允许的即梦 CLI 命令", false);
  }
  if (command === "relogin") {
    throw new DreaminaProcessError(DREAMINA_ERROR.commandRejected, "应用不会代跑即梦 relogin 命令", false);
  }
  if (command === "login") {
    // 中文注释：只允许 headless 授权和参数数组轮询，禁止任意 login 子命令或 shell 拼接。
    const action = extra[0];
    if (action === "--headless" && extra.length === 1) {
      return [command, ...extra];
    }
    if (
      action === "checklogin"
      && extra.length === 3
      && extra[1]?.startsWith("--device_code=")
      && extra[2] === "--poll=0"
    ) {
      return [command, ...extra];
    }
    throw new DreaminaProcessError(DREAMINA_ERROR.commandRejected, "只允许 login --headless 或 login checklogin 轮询", false);
  }
  for (const item of extra) {
    if (item.startsWith("--prompt=")) {
      // 中文注释：canonical 视频指令模板含换行；提示词只禁止 NUL，不得把合法模板误判成 argv 注入。
      if (item.includes("\0")) {
        throw new DreaminaProcessError(DREAMINA_ERROR.commandRejected, "命令参数包含非法控制字符", false);
      }
      continue;
    }
    if (/[\n\r\0]/.test(item)) {
      throw new DreaminaProcessError(DREAMINA_ERROR.commandRejected, "命令参数包含非法控制字符", false);
    }
  }
  if (command === "session") {
    const action = extra[0];
    if (!action || !["list", "search", "create"].includes(action)) {
      throw new DreaminaProcessError(DREAMINA_ERROR.commandRejected, "会话子命令只允许 list/search/create", false);
    }
  }
  return [command, ...extra];
}

export function flag(name: string, value: string | number | undefined): string[] {
  if (value === undefined || value === "") return [];
  return [`--${name}=${value}`];
}

export async function runDreaminaCommand(options: {
  executablePath: string;
  args: readonly string[];
  timeoutKind: DreaminaTimeoutKind;
  cwd?: string;
}): Promise<DreaminaRunResult> {
  const executable = assertSafeExecutable(options.executablePath);
  const command = options.args[0];
  if (!command) {
    throw new DreaminaProcessError(DREAMINA_ERROR.commandRejected, "缺少即梦 CLI 命令", false);
  }
  const args = buildAllowedArgs(command, options.args.slice(1));
  const invocation = resolveSpawnInvocation(executable);
  const timeoutMs = timeoutFor(options.timeoutKind);

  return await new Promise<DreaminaRunResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(invocation.file, [...invocation.argsPrefix, ...args], {
        shell: false,
        windowsHide: true,
        cwd: options.cwd,
        env: sanitizeEnv(process.env),
      });
    } catch (error) {
      reject(new DreaminaProcessError(
        error instanceof Error && error.message.includes("ENOENT")
          ? DREAMINA_ERROR.notInstalled
          : DREAMINA_ERROR.startFailed,
        error instanceof Error && error.message.includes("ENOENT")
          ? "未安装即梦 CLI 或无法执行"
          : "即梦 CLI 启动失败",
        false,
      ));
      return;
    }

    const stdout = createRingBuffer(OUTPUT_LIMIT);
    const stderr = createRingBuffer(OUTPUT_LIMIT);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 500);
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new DreaminaProcessError(
        error.message.includes("ENOENT") ? DREAMINA_ERROR.notInstalled : DREAMINA_ERROR.startFailed,
        error.message.includes("ENOENT") ? "未安装即梦 CLI 或无法执行" : "即梦 CLI 启动失败",
        false,
      ));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const stdoutText = stdout.toString();
      const stderrText = stderr.toString();
      resolve({
        stdout: stdoutText,
        stderr: stderrText,
        exitCode,
        timedOut,
        parsed: parseWhitelistedOutput(stdoutText),
      });
    });
  });
}

export function parseWhitelistedOutput(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return pickAllowedFields(parsed as Record<string, unknown>);
      }
    } catch {
      // 非 JSON 输出走字段抽取。
    }
  }
  const version = trimmed.match(/dreamina\s+([0-9]+(?:\.[0-9]+){1,3})/i)?.[1]
    ?? trimmed.match(/^(\d+\.\d+\.\d+(?:\.\d+)?)$/m)?.[1];
  if (version) return { version };
  return null;
}

export function pickAllowedFields(input: Record<string, unknown>): Record<string, unknown> {
  const allowed = [
    "submit_id",
    "status",
    "files",
    // 中文注释：当前官方 CLI 与参考实现使用 total_credit 返回积分。
    "total_credit",
    "credit_balance",
    "credit",
    "balance",
    "vip",
    "currency",
    "sessions",
    "id",
    "name",
    "version",
    "error",
    "message",
    "ok",
    "tasks",
    "gen_status",
  ] as const;
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in input) result[key] = sanitizeValue(input[key]);
  }
  return result;
}

export function redactSensitive(text: string): string {
  return text
    .replace(/cookie[^\s]*/gi, "[redacted]")
    .replace(/(authorization|token|secret)=?[^\s]*/gi, "[redacted]")
    .replace(/device_code[^\s]*/gi, "[redacted]")
    .replace(/user_code[^\s]*/gi, "[redacted]");
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitive(value).slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => sanitizeValue(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(record).slice(0, 16)) {
      if (/cookie|token|secret|password|credential/i.test(key)) continue;
      next[key] = sanitizeValue(nested);
    }
    return next;
  }
  return value;
}

function isUncPath(value: string): boolean {
  return /^[\\/]{2}[^\\/]/.test(value);
}

function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  const rejectedKeys = new Set(["dreamina_cli_raw_argv"]);
  if (process.env.NODE_TEST_CONTEXT) rejectedKeys.add("node_options");
  for (const key of Object.keys(next)) {
    // 中文注释：Windows 环境变量不区分大小写，展开为普通对象后必须按小写键统一删除注入入口。
    if (rejectedKeys.has(key.toLocaleLowerCase("en-US"))) delete next[key];
  }
  return next;
}

function createRingBuffer(limit: number) {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk: Buffer | string) {
      const next = Buffer.concat([buffer, Buffer.from(chunk)]);
      buffer = next.length <= limit ? next : next.subarray(next.length - limit);
    },
    toString() {
      return buffer.toString("utf8");
    },
  };
}

export function isDreaminaMode(value: string): value is DreaminaMode {
  return (DREAMINA_MODES as readonly string[]).includes(value);
}

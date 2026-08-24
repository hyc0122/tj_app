import {
  DREAMINA_ERROR,
  DREAMINA_PROVIDER_ID,
  DREAMINA_VIDEO_MODES,
  type DreaminaCapabilitySnapshot,
  type DreaminaQueryResult,
  type DreaminaReconcileInput,
  type DreaminaReconcileResult,
  type DreaminaSubmitInput,
  type DreaminaSubmitResult,
  type NativeMediaProvider,
} from "./contracts";
import { inspectLogin, probeDreaminaCapabilities } from "./capability-probe";
import { resolveDreaminaExecutable } from "./cli-truth";
import {
  DreaminaProcessError,
  assertManagedFilePath,
  flag,
  runDreaminaCommand,
} from "./process-runner";
import {
  readProjectSession,
  writeProjectSession,
} from "./session-store";

export { resolveDreaminaExecutable } from "./cli-truth";

export interface CreateDreaminaCliProviderOptions {
  executablePath?: string;
  projectRoot?: string;
  stagingDirectory?: string;
}

export async function createDreaminaCliProvider(
  options: CreateDreaminaCliProviderOptions = {},
): Promise<NativeMediaProvider> {
  const executablePath = await resolveDreaminaExecutable(options.executablePath);
  const roots = [options.projectRoot, options.stagingDirectory].filter(
    (item): item is string => Boolean(item),
  );

  const provider: NativeMediaProvider = {
    providerId: DREAMINA_PROVIDER_ID,

    async probe(): Promise<DreaminaCapabilitySnapshot> {
      return probeDreaminaCapabilities(executablePath);
    },

    async ensureProjectSession(projectUuid: string, projectName: string): Promise<string> {
      const existing = await readProjectSession(projectUuid);
      if (existing?.sessionId) return existing.sessionId;
      const sessionName = `天将-${projectName}`.slice(0, 80);
      const searched = await runDreaminaCommand({
        executablePath,
        args: ["session", "search", ...flag("name", sessionName)],
        timeoutKind: "session",
      });
      const found = firstSessionId(searched.parsed);
      if (found) {
        await persistSession(projectUuid, found.id, found.name || sessionName, executablePath);
        return found.id;
      }
      const listed = await runDreaminaCommand({
        executablePath,
        args: ["session", "list"],
        timeoutKind: "session",
      });
      const listedHit = firstSessionId(listed.parsed, sessionName);
      if (listedHit) {
        await persistSession(projectUuid, listedHit.id, listedHit.name || sessionName, executablePath);
        return listedHit.id;
      }
      const created = await runDreaminaCommand({
        executablePath,
        args: ["session", "create", ...flag("name", sessionName)],
        timeoutKind: "session",
      });
      const createdId = String(created.parsed?.id ?? firstSessionId(created.parsed)?.id ?? "");
      if (!createdId) {
        throw new DreaminaProcessError(DREAMINA_ERROR.definiteFailure, "无法创建即梦会话", true);
      }
      await persistSession(projectUuid, createdId, sessionName, executablePath);
      return createdId;
    },

    async submit(input: DreaminaSubmitInput): Promise<DreaminaSubmitResult> {
      try {
        const args = buildSubmitArgs(input, roots);
        const result = await runDreaminaCommand({
          executablePath,
          args,
          timeoutKind: "submit",
          cwd: options.stagingDirectory,
        });
        if (result.timedOut) {
          return { kind: "outcome_unknown", message: "提交超时，远端结果待确认，禁止盲目补发" };
        }
        const parsed = result.parsed ?? {};
        const submitId = typeof parsed.submit_id === "string" ? parsed.submit_id : "";
        const files = Array.isArray(parsed.files)
          ? parsed.files.filter((item): item is string => typeof item === "string")
          : [];
        if (result.exitCode !== 0 && !submitId) {
          if (result.exitCode === 2 || parsed.error) {
            return {
              kind: "definite_failure",
              code: DREAMINA_ERROR.definiteFailure,
              retryable: false,
              message: String(parsed.message || parsed.error || "即梦 CLI 明确拒绝本次提交"),
            };
          }
          return {
            kind: "outcome_unknown",
            message: "已经可能提交但没有 submit_id，结果待确认",
          };
        }
        if (files.length > 0) {
          return { kind: "completed", submitId: submitId || "local-completed", files };
        }
        if (submitId) return { kind: "submitted", submitId };
        return { kind: "outcome_unknown", message: "已经可能提交但没有 submit_id，结果待确认" };
      } catch (error) {
        if (error instanceof DreaminaProcessError && error.code === DREAMINA_ERROR.pathRejected) {
          throw error;
        }
        if (
          error instanceof DreaminaProcessError
          && (error.code === DREAMINA_ERROR.notInstalled
            || error.code === DREAMINA_ERROR.startFailed
            || error.code === DREAMINA_ERROR.invalidArgument)
        ) {
          return {
            kind: "definite_failure",
            code: error.code,
            retryable: false,
            message: error.code === DREAMINA_ERROR.startFailed
              ? "即梦 CLI 启动失败"
              : error.code === DREAMINA_ERROR.invalidArgument
                ? "即梦 CLI 请求参数不合法"
                : error.message,
          };
        }
        return {
          kind: "outcome_unknown",
          message: "提交结果不明",
        };
      }
    },

    async query(input: { submitId: string; stagingDirectory: string }): Promise<DreaminaQueryResult> {
      const result = await runDreaminaCommand({
        executablePath,
        args: ["query_result", ...flag("submit_id", input.submitId), ...flag("download_dir", input.stagingDirectory)],
        timeoutKind: "query",
        cwd: input.stagingDirectory,
      });
      if (result.timedOut) {
        return { kind: "outcome_unknown", message: "查询超时，结果待确认" };
      }
      const parsed = result.parsed ?? {};
      const files = Array.isArray(parsed.files)
        ? parsed.files.filter((item): item is string => typeof item === "string")
        : [];
      // 中文注释：不同 CLI 版本分别返回 gen_status 或 status，统一归一化后再判定终态。
      const status = String(parsed.gen_status ?? parsed.status ?? "").trim().toLowerCase();
      if (["cancelled", "canceled"].includes(status)) {
        return {
          kind: "definite_failure",
          code: DREAMINA_ERROR.definiteFailure,
          retryable: false,
          message: "任务已在即梦侧取消",
        };
      }
      if (["failed", "fail", "error"].includes(status)) {
        return {
          kind: "definite_failure",
          code: DREAMINA_ERROR.definiteFailure,
          retryable: true,
          message: "即梦任务生成失败",
        };
      }
      // 中文注释：取消/失败状态优先于残留 files，避免供应商返回旧文件列表时把已取消任务误判为成功。
      if (files.length > 0 || ["success", "completed", "complete"].includes(status)) {
        return { kind: "completed", submitId: input.submitId, files };
      }
      if (["querying", "running", "pending", "processing"].includes(status)) {
        return { kind: "running", submitId: input.submitId };
      }
      if (result.exitCode !== 0) {
        return {
          kind: "definite_failure",
          code: DREAMINA_ERROR.definiteFailure,
          retryable: true,
          message: String(parsed.message || "查询失败"),
        };
      }
      if (status) {
        // 中文注释：未知非空状态不得伪装运行中，否则会无限轮询并掩盖真实取消或失败。
        return {
          kind: "definite_failure",
          code: DREAMINA_ERROR.definiteFailure,
          retryable: false,
          message: "即梦返回未知任务状态，已停止自动轮询",
        };
      }
      return { kind: "running", submitId: input.submitId };
    },

    async reconcileUnknown(input: DreaminaReconcileInput): Promise<DreaminaReconcileResult> {
      const args = ["list_task"];
      if (input.submitId) args.push(...flag("submit_id", input.submitId));
      const result = await runDreaminaCommand({
        executablePath,
        args,
        timeoutKind: "query",
      });
      const tasks = Array.isArray(result.parsed?.tasks) ? result.parsed?.tasks : [];
      if (input.submitId && tasks.length === 1) {
        return { kind: "recovered", submitId: input.submitId, message: "已通过官方任务列表对账" };
      }
      return { kind: "unknown", message: "无法唯一确认远端任务，保持结果待确认" };
    },
  };

  return provider;
}

export async function runDreaminaSelfCheck(executablePath?: string): Promise<{
  loggedIn: boolean;
  creditBalance?: number;
  vip?: boolean;
  currency?: string;
  reason?: string;
}> {
  const resolved = await resolveDreaminaExecutable(executablePath);
  return inspectLogin(resolved);
}

export async function runDreaminaLogout(executablePath?: string): Promise<void> {
  const resolved = await resolveDreaminaExecutable(executablePath);
  const result = await runDreaminaCommand({
    executablePath: resolved,
    args: ["logout"],
    timeoutKind: "logout",
  });
  if (result.timedOut || (result.exitCode !== 0 && result.exitCode !== null)) {
    throw new DreaminaProcessError(DREAMINA_ERROR.definiteFailure, "退出即梦登录失败", true);
  }
}

function buildSubmitArgs(input: DreaminaSubmitInput, roots: readonly string[]): string[] {
  if (input.width != null || input.height != null) {
    if (input.width == null || input.height == null) {
      throw new DreaminaProcessError(DREAMINA_ERROR.definiteFailure, "自定义宽高必须成对出现", false);
    }
    if (input.ratio) {
      throw new DreaminaProcessError(DREAMINA_ERROR.definiteFailure, "自定义宽高与比例互斥", false);
    }
  }
  // 中文注释：prompt 是所有生成模式的共同必需参数；能力探测缺少该字段时会直接禁用模式。
  const args = [input.mode, ...flag("prompt", input.prompt)];
  args.push(...flag("ratio", input.ratio));
  args.push(...flag("resolution_type", input.resolutionType));
  args.push(...flag("video_resolution", input.videoResolution));
  args.push(...flag("duration", input.duration));
  args.push(...flag("model_version", input.modelVersion));
  // 中文注释：官方视频合同要求 --poll；图片模式不得误加，避免真实 CLI 当成非法参数。
  if ((DREAMINA_VIDEO_MODES as readonly string[]).includes(input.mode)) {
    args.push(...flag("poll", input.pollSeconds ?? 30));
  }
  args.push(...flag("generate_num", input.generateNum));
  args.push(...flag("width", input.width));
  args.push(...flag("height", input.height));
  args.push(...flag("session_id", input.sessionId));
  if (input.image) args.push(...flag("image", assertPath(input.image, roots)));
  if (input.video) args.push(...flag("video", assertPath(input.video, roots)));
  if (input.audio) args.push(...flag("audio", assertPath(input.audio, roots)));
  if (input.mode === "frames2video") {
    args.push(...flag("first", input.first ? assertPath(input.first, roots) : undefined));
    args.push(...flag("last", input.last ? assertPath(input.last, roots) : undefined));
  } else if (input.mode === "multimodal2video") {
    // 中文注释：多模态 CLI 使用可重复参数，不能把多个文件错误拼成单个路径。
    for (const item of input.images ?? []) args.push(...flag("image", assertPath(item, roots)));
    for (const item of input.videos ?? []) args.push(...flag("video", assertPath(item, roots)));
    for (const item of input.audios ?? []) args.push(...flag("audio", assertPath(item, roots)));
  } else if (input.images && input.images.length > 0) {
    const joined = input.images.map((item) => assertPath(item, roots)).join(",");
    args.push(...flag("images", joined));
  }
  return args;
}

function assertPath(filePath: string, roots: readonly string[]): string {
  if (roots.length === 0) {
    throw new DreaminaProcessError(DREAMINA_ERROR.pathRejected, "缺少项目受管目录，拒绝传递参考文件", false);
  }
  return assertManagedFilePath(filePath, roots);
}

async function persistSession(
  projectUuid: string,
  sessionId: string,
  sessionName: string,
  executablePath: string,
): Promise<void> {
  let cliVersion = "";
  try {
    const probed = await probeDreaminaCapabilities(executablePath);
    cliVersion = probed.version ?? "";
  } catch {
    cliVersion = "";
  }
  await writeProjectSession({ projectUuid, sessionId, sessionName, cliVersion });
}

function firstSessionId(
  parsed: Record<string, unknown> | null,
  preferredName?: string,
): { id: string; name: string } | null {
  if (!parsed) return null;
  const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  const records = sessions
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      const name = typeof record.name === "string" ? record.name : "";
      return id ? { id, name } : null;
    })
    .filter((item): item is { id: string; name: string } => Boolean(item));
  if (preferredName) {
    const matched = records.find((item) => item.name === preferredName);
    if (matched) return matched;
  }
  return records[0] ?? null;
}

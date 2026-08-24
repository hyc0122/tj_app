import { useI18n } from "vue-i18n";
import axios from "@/utils/axios";
import { openDreaminaExternal } from "@/features/tianjiang/dreamina/external-links";
import { DREAMINA_VIDEO_MODELS } from "@/features/tianjiang/dreamina/video-models";

type DreaminaQueuePauseReason = "none" | "disabled" | "manual_pause" | "lifecycle_drain";

interface DreaminaQueueStatus {
  updatedAt?: number;
  paused?: boolean;
  pauseReason?: DreaminaQueuePauseReason;
  maxConcurrency?: number;
  queued?: number;
  active?: number;
  unknown?: number;
}

interface DreaminaPanelStatus {
  preferredExecutionTarget?: string;
  effectiveExecutionTarget?: string | null;
  install?: { state?: string; version?: string | null; executablePath?: string | null; managed?: boolean; reason?: string };
  account?: {
    state?: string;
    lastKnownState?: string;
    verified?: boolean;
    points?: string;
    planName?: string;
    expiresAt?: string;
    reason?: string;
  };
  capability?: { snapshot?: { capabilities?: string[]; videoModels?: string[] } | null };
  queue?: DreaminaQueueStatus;
}

interface DreaminaAuthorizationRequired {
  state: "authorization_required";
  verificationUri: string;
  userCode: string;
  expiresAt: number;
  pollIntervalSeconds: number;
  authorizationId: string;
}

type DreaminaAuthorizationStartResult =
  | { state: "already_logged_in" }
  | DreaminaAuthorizationRequired;

type PanelAction =
  | "recheck"
  | "install"
  | "repair"
  | "authorize"
  | "refreshAccount"
  | "logout"
  | "checkAuthorization"
  | "officialDocs"
  | "savePath"
  | "checkCli"
  | "checkLogin"
  | "pauseQueue"
  | "resumeQueue"
  | "saveConcurrency"
  | "savePollSeconds";

function unwrapData<T>(payload: unknown): T {
  if (!payload || typeof payload !== "object") return {} as T;
  const record = payload as { data?: T } & T;
  return (record.data ?? record) as T;
}

function safeErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; data?: { message?: unknown } };
    const message = record.message ?? record.data?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return fallback;
}

export function useDreaminaProviderPanel() {
  const { t } = useI18n();
  const status = ref<DreaminaPanelStatus | null>(null);
  const enabled = ref(true);
  const enabledRevision = ref(0);
  const enabledRequestGeneration = ref(0);
  const executablePathDraft = ref("");
  const resolvedExecutablePath = ref("");
  const maxConcurrencyDraft = ref(1);
  const pollSecondsDraft = ref(30);
  const pollSecondsCommitted = ref(30);
  const sessionLoginVerified = ref(false);
  const pathJustSaved = ref(false);
  const pendingAction = ref<PanelAction | "">("");
  const feedback = ref<{ type: "success" | "error"; message: string }>({ type: "success", message: "" });
  const authVisible = ref(false);
  const authUri = ref("");
  const authUserCode = ref("");
  const authExpiresAt = ref(0);
  const authorizationId = ref("");
  const authorizationPollSeconds = ref(5);
  let authorizationTimer: number | undefined;

  function setFeedback(type: "success" | "error", message: string) {
    feedback.value = { type, message };
  }

  function acceptEnabledRevision(updatedAt: unknown, fromPost = false): boolean {
    const next = Number(updatedAt);
    if (!Number.isFinite(next) || next <= 0) {
      return fromPost || enabledRequestGeneration.value === 0;
    }
    // 中文注释：POST 提升本地代际；其后到达的同 revision GET 一律视为旧响应。
    if (fromPost) {
      enabledRequestGeneration.value += 1;
      enabledRevision.value = Math.max(enabledRevision.value + 1, next);
      return true;
    }
    if (enabledRequestGeneration.value > 0 && next <= enabledRevision.value) return false;
    if (next < enabledRevision.value) return false;
    enabledRevision.value = next;
    return true;
  }

  function applyEnabledPayload(payload: {
    enabled?: boolean;
    updatedAt?: number;
    install?: DreaminaPanelStatus["install"];
    account?: DreaminaPanelStatus["account"];
    capability?: DreaminaPanelStatus["capability"];
    queue?: DreaminaPanelStatus["queue"];
    executablePath?: string | null;
  }, fromPost = false): boolean {
    if (!acceptEnabledRevision(payload.updatedAt, fromPost)) return false;
    if (payload.enabled !== undefined) enabled.value = payload.enabled !== false;
    // 中文注释：POST 的 enabled/queue/install/account 必须按同一 revision 原子合并。
    if (payload.install || payload.account || payload.capability || payload.queue) {
      status.value = {
        ...(status.value ?? {}),
        install: payload.install ?? status.value?.install,
        account: payload.account ?? status.value?.account,
        capability: payload.capability ?? status.value?.capability,
        queue: payload.queue ?? status.value?.queue,
      };
    }
    const resolved = payload.install?.executablePath || payload.executablePath;
    if (resolved) resolvedExecutablePath.value = String(resolved);
    return true;
  }

  function displayOrMissing(value?: string | null) {
    return value && String(value).trim() ? String(value) : t("settings.dreaminaCli.fieldMissing");
  }

  const installReady = computed(() => (
    status.value?.install?.state === "installed"
    && Boolean(status.value.install?.executablePath || resolvedExecutablePath.value || executablePathDraft.value.trim())
  ));

  const accountDisplay = computed(() => {
    const account = status.value?.account;
    // 中文注释：保存路径后必须回到未检测，不能继续展示上次已登录。
    if (pathJustSaved.value) {
      return "unchecked";
    }
    const liveVerified = sessionLoginVerified.value || account?.verified === true;
    if (!liveVerified) {
      if (account?.lastKnownState === "logged_in" || account?.state === "logged_in") {
        return "last_known";
      }
      return "unchecked";
    }
    if (account?.state === "logged_out") return "logged_out";
    if (!installReady.value && account?.state !== "logged_in") return "unchecked";
    if (account?.state === "logged_in") return "logged_in";
    if (account?.state === "failed") return "failed";
    if (account?.state === "authorizing") return "authorizing";
    return "unchecked";
  });

  const installStateText = computed(() => {
    const state = status.value?.install?.state;
    if (state === "installed") return t("settings.dreaminaCli.installed");
    if (state === "not_installed") return t("settings.dreaminaCli.notInstalled");
    if (state === "failed") return "安装失败";
    if (state === "installing") return "安装中";
    return displayOrMissing(state);
  });

  const accountStateText = computed(() => {
    if (accountDisplay.value === "last_known") return t("settings.dreaminaCli.lastKnownLoggedIn");
    if (accountDisplay.value === "unchecked") return t("settings.dreaminaCli.unchecked");
    if (accountDisplay.value === "logged_in") return t("settings.dreaminaCli.loggedIn");
    if (accountDisplay.value === "logged_out") return t("settings.dreaminaCli.notLoggedIn");
    if (accountDisplay.value === "authorizing") return "等待授权";
    if (accountDisplay.value === "failed") return "检测失败";
    return displayOrMissing(status.value?.account?.state);
  });

  const executionTargetText = computed(() => {
    const target = status.value?.effectiveExecutionTarget || status.value?.preferredExecutionTarget;
    if (target === "windows_native") return "Windows 原生";
    if (target === "wsl") return "WSL";
    return "尚未确定";
  });

  const queueSummaryText = computed(() => `${status.value?.queue?.queued ?? 0} 个任务排队`);
  const queuePauseReason = computed(() => status.value?.queue?.pauseReason ?? (
    status.value?.queue?.paused ? "manual_pause" : "none"
  ));
  const queuePauseReasonText = computed(() => {
    if (queuePauseReason.value === "disabled") return "即梦 CLI 已关闭";
    if (queuePauseReason.value === "manual_pause") return "手动暂停，任务会保留且不会自动领取";
    if (queuePauseReason.value === "lifecycle_drain") return "正在进行生命周期排空，稍后会自动恢复";
    return "队列运行中，本地调度器自动领取任务";
  });
  const modelNames = computed(() => {
    const detected = status.value?.capability?.snapshot?.videoModels;
    if (!Array.isArray(detected)) return [...DREAMINA_VIDEO_MODELS];
    const detectedSet = new Set(detected);
    const verified = DREAMINA_VIDEO_MODELS.filter((model) => detectedSet.has(model));
    // 中文注释：产品模型清单必须完整稳定；探测值缺失或不完整时使用同一份内置清单。
    return verified.length === DREAMINA_VIDEO_MODELS.length ? verified : [...DREAMINA_VIDEO_MODELS];
  });
  const installGuidance = computed(() => status.value?.install?.state === "installed" ? "CLI 已准备就绪" : "点击安装执行即梦官方命令");

  const displayedPoints = computed(() => {
    if (accountDisplay.value !== "logged_in") return displayOrMissing("");
    return status.value?.account?.points
      ? String(status.value.account.points)
      : t("settings.dreaminaCli.creditsMissing");
  });

  function statusTone(state?: string) {
    if (state === "account") {
      if (accountDisplay.value === "logged_in") return "statusDot--success";
      if (accountDisplay.value === "failed") return "statusDot--danger";
      if (accountDisplay.value === "authorizing" || accountDisplay.value === "last_known") return "statusDot--warning";
      return "statusDot--neutral";
    }
    if (["installed", "logged_in", "ready"].includes(String(state))) return "statusDot--success";
    if (["failed", "expired", "unknown"].includes(String(state))) return "statusDot--danger";
    if (["installing", "authorizing"].includes(String(state))) return "statusDot--warning";
    return "statusDot--neutral";
  }

  async function reloadStatus(): Promise<void> {
    const payload = unwrapData<DreaminaPanelStatus & { enabled?: boolean; updatedAt?: number }>(
      await axios.get("/setting/dreaminaCli/getStatus"),
    );
    if (!acceptEnabledRevision(payload.updatedAt)) return;
    status.value = payload;
    maxConcurrencyDraft.value = Math.min(8, Math.max(1, Number(payload.queue?.maxConcurrency) || 1));
    if (payload.enabled !== undefined) enabled.value = payload.enabled !== false;
    // 中文注释：只有本次启动检测 verified 才能升格为已登录，禁止把缓存 last_known 当真值。
    if (!pathJustSaved.value && status.value?.account?.verified === true) {
      sessionLoginVerified.value = true;
    }
    const resolved = status.value?.install?.executablePath;
    if (resolved) resolvedExecutablePath.value = String(resolved);
  }

  async function reloadSettings(): Promise<void> {
    const settings = unwrapData<{
      executablePath?: string | null;
      enabled?: boolean;
      updatedAt?: number;
      maxConcurrency?: number;
      pollSeconds?: number;
      pauseReason?: DreaminaQueuePauseReason;
      pauseNewClaims?: boolean;
    }>(
      await axios.get("/setting/dreaminaCli/getSettings"),
    );
    // 中文注释：先过修订门，再一次性应用设置快照，旧 GET 不得覆盖任何新 POST 字段。
    if (!acceptEnabledRevision(settings.updatedAt)) return;
    const nextExecutablePath = settings.executablePath ? String(settings.executablePath) : "";
    const nextMaxConcurrency = Math.min(8, Math.max(1, Number(settings.maxConcurrency) || 1));
    const parsedPollSeconds = Number(settings.pollSeconds);
    const nextPollSeconds = Number.isInteger(parsedPollSeconds) && parsedPollSeconds >= 5 && parsedPollSeconds <= 300
      ? parsedPollSeconds
      : 30;
    executablePathDraft.value = nextExecutablePath;
    maxConcurrencyDraft.value = nextMaxConcurrency;
    pollSecondsDraft.value = nextPollSeconds;
    pollSecondsCommitted.value = nextPollSeconds;
    if (settings.pauseReason || settings.maxConcurrency !== undefined) {
      status.value = {
        ...(status.value ?? {}),
        queue: {
          ...(status.value?.queue ?? {}),
          maxConcurrency: maxConcurrencyDraft.value,
          paused: settings.pauseReason
            ? settings.pauseReason !== "none"
            : status.value?.queue?.paused ?? settings.pauseNewClaims === true,
          pauseReason: settings.pauseReason ?? status.value?.queue?.pauseReason,
        },
      };
    }
    if (settings.enabled !== undefined) {
      enabled.value = settings.enabled !== false;
    }
  }

  function clearAuthorizationTimer() {
    if (authorizationTimer !== undefined) window.clearTimeout(authorizationTimer);
    authorizationTimer = undefined;
  }

  function clearAuthorizationMaterial() {
    clearAuthorizationTimer();
    authVisible.value = false;
    authUri.value = "";
    authUserCode.value = "";
    authExpiresAt.value = 0;
    authorizationId.value = "";
    authorizationPollSeconds.value = 5;
  }

  function scheduleAuthorizationCheck() {
    clearAuthorizationTimer();
    if (!authorizationId.value || !authVisible.value) return;
    authorizationTimer = window.setTimeout(() => { void checkAuthorization(false); }, Math.max(5, authorizationPollSeconds.value) * 1000);
  }

  async function applyLiveAccount(payload: unknown): Promise<void> {
    const live = unwrapData<{
      account?: DreaminaPanelStatus["account"];
      loggedIn?: boolean;
      points?: string;
      install?: DreaminaPanelStatus["install"];
      resolvedExecutablePath?: string;
      version?: string;
    }>(payload);
    if (live.resolvedExecutablePath) resolvedExecutablePath.value = live.resolvedExecutablePath;
    const nextAccount = live.account ?? (live.loggedIn === undefined ? undefined : {
      ...(status.value?.account ?? {}),
      state: live.loggedIn ? "logged_in" : "logged_out",
      points: live.points,
      verified: true,
    });
    await reloadStatus();
    if (live.install || nextAccount) {
      status.value = {
        ...(status.value ?? {}),
        install: live.install ?? status.value?.install,
        account: nextAccount ?? status.value?.account,
      };
    }
  }

  async function checkAuthorization(manual: boolean): Promise<void> {
    if (!authorizationId.value || pendingAction.value) return;
    pendingAction.value = "checkAuthorization";
    try {
      const result = unwrapData<{ state?: string }>(await axios.post(
        "/setting/dreaminaCli/checkAuthorization",
        { authorizationId: authorizationId.value },
      ));
      if (result.state === "logged_in") {
        clearAuthorizationMaterial();
        // 中文注释：授权完成后必须再跑 user_credit，不能把授权成功直接当成积分真值。
        await axios.post("/setting/dreaminaCli/checkLogin");
        sessionLoginVerified.value = true;
        setFeedback("success", "授权成功，即梦账户已登录");
        await reloadStatus();
        return;
      }
      if (result.state === "expired" || result.state === "failed") {
        // 中文注释：过期与失败都是终态，必须同时清除用户码、地址和内部 authorizationId。
        clearAuthorizationMaterial();
        setFeedback("error", result.state === "expired" ? "授权已过期，请重新发起登录授权" : "授权失败，请重新尝试");
        return;
      }
      if (manual) setFeedback("success", "仍在等待授权，请在浏览器完成确认");
      scheduleAuthorizationCheck();
    } catch (error) {
      setFeedback("error", safeErrorMessage(error, "检查授权状态失败"));
      scheduleAuthorizationCheck();
    } finally {
      pendingAction.value = "";
    }
  }

  async function setDreaminaEnabled(next: boolean) {
    if (pendingAction.value) return;
    const previous = enabled.value;
    pendingAction.value = "savePath";
    try {
      const saved = unwrapData<{
        enabled?: boolean;
        updatedAt?: number;
        executablePath?: string | null;
        install?: DreaminaPanelStatus["install"];
        account?: DreaminaPanelStatus["account"];
        capability?: DreaminaPanelStatus["capability"];
      }>(await axios.post(
        "/setting/dreaminaCli/setEnabled",
        { enabled: next },
      ));
      if (!applyEnabledPayload(saved, true)) enabled.value = previous;
      if (next && saved.account?.state === "logged_in") {
        sessionLoginVerified.value = true;
        pathJustSaved.value = false;
      }
      if (!next) sessionLoginVerified.value = false;
      setFeedback("success", next ? t("settings.dreaminaCli.enabledState") : t("settings.dreaminaCli.disabledState"));
    } catch (error) {
      enabled.value = previous;
      setFeedback("error", safeErrorMessage(error, "更新即梦启停状态失败"));
    } finally {
      pendingAction.value = "";
    }
  }

  async function setQueuePaused(nextPaused: boolean) {
    if (pendingAction.value) return;
    const action: PanelAction = nextPaused ? "pauseQueue" : "resumeQueue";
    pendingAction.value = action;
    try {
      const queue = unwrapData<DreaminaQueueStatus>(await axios.post(
        nextPaused ? "/task/dreaminaQueue/pause" : "/task/dreaminaQueue/resume",
      ));
      // 中文注释：只有服务端成功响应才能更新暂停状态，网络失败不得在页面上假装已恢复。
      if (!acceptEnabledRevision(queue.updatedAt, true)) return;
      status.value = {
        ...(status.value ?? {}),
        queue: { ...(status.value?.queue ?? {}), ...(queue ?? {}) },
      };
      setFeedback("success", nextPaused ? "即梦队列已手动暂停" : "即梦队列已恢复自动领取");
    } catch (error) {
      setFeedback("error", safeErrorMessage(error, nextPaused ? "暂停队列失败" : "恢复队列失败"));
    } finally {
      pendingAction.value = "";
    }
  }

  async function saveMaxConcurrency() {
    if (pendingAction.value) return;
    const next = Number(maxConcurrencyDraft.value);
    if (!Number.isInteger(next) || next < 1 || next > 8) {
      maxConcurrencyDraft.value = status.value?.queue?.maxConcurrency ?? 1;
      setFeedback("error", "并发上限必须是 1 到 8 的整数");
      return;
    }
    pendingAction.value = "saveConcurrency";
    try {
      const saved = unwrapData<{
        maxConcurrency?: number;
        pauseReason?: DreaminaQueuePauseReason;
        updatedAt?: number;
      }>(
        await axios.post("/setting/dreaminaCli/updateSettings", { maxConcurrency: next }),
      );
      const committed = Number(saved.maxConcurrency);
      if (!Number.isInteger(committed) || committed < 1 || committed > 8) {
        throw new Error("服务端未返回有效的并发上限");
      }
      if (!acceptEnabledRevision(saved.updatedAt, true)) return;
      maxConcurrencyDraft.value = committed;
      status.value = {
        ...(status.value ?? {}),
        queue: {
          ...(status.value?.queue ?? {}),
          maxConcurrency: committed,
          pauseReason: saved.pauseReason ?? status.value?.queue?.pauseReason,
        },
      };
      setFeedback("success", `并发上限已更新为 ${committed}`);
    } catch (error) {
      maxConcurrencyDraft.value = status.value?.queue?.maxConcurrency ?? 1;
      setFeedback("error", safeErrorMessage(error, "保存并发上限失败"));
    } finally {
      pendingAction.value = "";
    }
  }

  async function savePollSeconds() {
    if (pendingAction.value) return;
    const next = Number(pollSecondsDraft.value);
    if (!Number.isInteger(next) || next < 5 || next > 300) {
      pollSecondsDraft.value = pollSecondsCommitted.value;
      setFeedback("error", "轮询间隔必须是 5 到 300 秒的整数");
      return;
    }
    pendingAction.value = "savePollSeconds";
    try {
      const saved = unwrapData<{ pollSeconds?: number; updatedAt?: number }>(
        await axios.post("/setting/dreaminaCli/updateSettings", { pollSeconds: next }),
      );
      const committed = Number(saved.pollSeconds);
      if (!Number.isInteger(committed) || committed < 5 || committed > 300) {
        throw new Error("服务端未返回有效的轮询间隔");
      }
      if (!acceptEnabledRevision(saved.updatedAt, true)) return;
      // 中文注释：只在服务端确认后推进已提交值，失败时草稿必须回滚到该值。
      pollSecondsCommitted.value = committed;
      pollSecondsDraft.value = committed;
      setFeedback("success", `轮询间隔已更新为 ${committed} 秒`);
    } catch (error) {
      pollSecondsDraft.value = pollSecondsCommitted.value;
      setFeedback("error", safeErrorMessage(error, "保存轮询间隔失败"));
    } finally {
      pendingAction.value = "";
    }
  }

  async function requestAction(action: Exclude<PanelAction, "checkAuthorization" | "officialDocs" | "pauseQueue" | "resumeQueue" | "saveConcurrency" | "savePollSeconds">) {
    if (pendingAction.value) return;
    pendingAction.value = action;
    feedback.value.message = "";
    try {
      if (action === "savePath") {
        const saved = unwrapData<{ executablePath?: string | null }>(await axios.post(
          "/setting/dreaminaCli/updateSettings",
          { executablePath: executablePathDraft.value.trim() || null },
        ));
        executablePathDraft.value = saved.executablePath ? String(saved.executablePath) : executablePathDraft.value;
        sessionLoginVerified.value = false;
        pathJustSaved.value = true;
        resolvedExecutablePath.value = "";
        await reloadStatus();
        setFeedback("success", t("settings.dreaminaCli.pathSaved"));
        return;
      }
      if (action === "checkCli") {
        const result = unwrapData<{
          available?: boolean;
          resolvedExecutablePath?: string;
          version?: string;
        }>(await axios.post("/setting/dreaminaCli/checkCli"));
        const resolved = result.resolvedExecutablePath?.trim() ?? "";
        await reloadSettings();
        if (resolved) {
          // 中文注释：检测成功后回填真实绝对路径；不得被仍保存裸命令的设置响应覆盖。
          resolvedExecutablePath.value = resolved;
          executablePathDraft.value = resolved;
        }
        await reloadStatus();
        setFeedback(
          result.available ? "success" : "error",
          result.available ? t("settings.dreaminaCli.cliAvailable") : t("settings.dreaminaCli.cliUnavailable"),
        );
        return;
      }
      if (action === "checkLogin") {
        await applyLiveAccount(await axios.post("/setting/dreaminaCli/checkLogin"));
        sessionLoginVerified.value = true;
        pathJustSaved.value = false;
        setFeedback("success", "登录检测已完成");
        return;
      }
      if (action === "recheck") {
        const result = unwrapData<{
          install?: DreaminaPanelStatus["install"];
          account?: DreaminaPanelStatus["account"];
          loggedIn?: boolean;
        }>(await axios.post("/setting/dreaminaCli/runSelfCheck"));
        sessionLoginVerified.value = true;
        pathJustSaved.value = false;
        if (result.install?.executablePath) resolvedExecutablePath.value = result.install.executablePath;
        await reloadStatus();
        setFeedback("success", "检测完成，安装、账户与模型状态已刷新");
        return;
      }
      if (action === "authorize") {
        // 中文注释：发起新授权前先清掉旧会话，避免失败响应继续沿用旧材料。
        clearAuthorizationMaterial();
        const payload = unwrapData<DreaminaAuthorizationStartResult>(
          await axios.post("/setting/dreaminaCli/startAuthorization", { confirm: true }),
        );
        if (payload.state === "already_logged_in") {
          // 中文注释：复用既有登录态时不展示空授权弹窗，但仍需 user_credit 复核。
          clearAuthorizationMaterial();
          await axios.post("/setting/dreaminaCli/checkLogin");
          sessionLoginVerified.value = true;
          await reloadStatus();
          setFeedback("success", "账号已登录，已刷新当前设备状态");
          return;
        }
        if (payload.state !== "authorization_required") throw new Error("CLI 返回了无法识别的授权状态");
        if (!payload.verificationUri || !payload.userCode || !payload.authorizationId) throw new Error("CLI 未返回完整授权材料");
        authUri.value = payload.verificationUri;
        authUserCode.value = payload.userCode;
        authExpiresAt.value = payload.expiresAt ?? 0;
        authorizationId.value = payload.authorizationId;
        authorizationPollSeconds.value = Math.max(5, payload.pollIntervalSeconds ?? 5);
        authVisible.value = true;
        setFeedback("success", "授权信息已准备，请在默认浏览器完成确认");
        scheduleAuthorizationCheck();
        return;
      }
      if (action === "refreshAccount") {
        await applyLiveAccount(await axios.post("/setting/dreaminaCli/refreshAccount"));
        sessionLoginVerified.value = true;
        pathJustSaved.value = false;
        setFeedback("success", "账户信息已刷新");
        return;
      }
      if (action === "logout") {
        await axios.post("/setting/dreaminaCli/logout", { confirm: true });
        clearAuthorizationMaterial();
        sessionLoginVerified.value = true;
        await reloadStatus();
        setFeedback("success", "已退出当前设备的即梦账户");
        return;
      }
      if (action === "install") {
        await axios.post("/setting/dreaminaCli/install", { confirm: true });
        const checked = unwrapData<{
          available?: boolean;
          resolvedExecutablePath?: string;
        }>(await axios.post("/setting/dreaminaCli/checkCli"));
        if (checked.resolvedExecutablePath) resolvedExecutablePath.value = checked.resolvedExecutablePath;
        await reloadStatus();
        setFeedback(
          "success",
          checked.available
            ? "安装完成，CLI 已可用"
            : "安装命令已执行，但仍未检测到 CLI，请重启软件后再检测",
        );
        return;
      }
      await axios.post(`/setting/dreaminaCli/${action}`, { confirm: true });
      await reloadStatus();
      setFeedback("success", "即梦 CLI 修复完成");
    } catch (error) {
      setFeedback("error", safeErrorMessage(error, `${action === "install" ? "安装" : "操作"}失败，请重试`));
    } finally {
      pendingAction.value = "";
    }
  }

  async function copyAuthorization(kind: "url" | "code") {
    const value = kind === "url" ? authUri.value : authUserCode.value;
    if (!value) return setFeedback("error", "授权信息不可用，请重新发起登录授权");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("当前环境不支持剪贴板");
      await navigator.clipboard.writeText(value);
      setFeedback("success", kind === "url" ? "授权地址已复制" : "用户码已复制");
    } catch (error) {
      setFeedback("error", safeErrorMessage(error, "复制失败，请手动选择文本"));
    }
  }

  async function openAuthorizationBrowser() {
    try {
      await openDreaminaExternal("authorization", authUri.value);
      setFeedback("success", "已在默认浏览器打开授权页");
    } catch (error) {
      setFeedback("error", safeErrorMessage(error, "默认浏览器打开失败"));
    }
  }

  async function openOfficialDocs() {
    if (pendingAction.value) return;
    pendingAction.value = "officialDocs";
    try {
      await openDreaminaExternal("official_docs");
      setFeedback("success", "已在默认浏览器打开即梦官方文档");
    } catch (error) {
      setFeedback("error", safeErrorMessage(error, "官方文档打开失败"));
    } finally {
      pendingAction.value = "";
    }
  }

  watch(authVisible, (visible) => { if (!visible) clearAuthorizationTimer(); });
  onMounted(() => {
    // 中文注释：挂载只读 getStatus/getSettings；verified logged_in 才显示已登录，绝不自动 login。
    void Promise.all([reloadStatus(), reloadSettings()]).catch((error) => (
      setFeedback("error", safeErrorMessage(error, "读取即梦状态失败"))
    ));
  });
  onBeforeUnmount(clearAuthorizationTimer);

  return {
    status,
    enabled,
    setDreaminaEnabled,
    reloadStatus,
    executablePathDraft,
    resolvedExecutablePath,
    sessionLoginVerified,
    accountDisplay,
    displayedPoints,
    pendingAction,
    feedback,
    authVisible,
    authUri,
    authUserCode,
    authExpiresAt,
    installStateText,
    accountStateText,
    executionTargetText,
    queueSummaryText,
    queuePauseReason,
    queuePauseReasonText,
    maxConcurrencyDraft,
    pollSecondsDraft,
    modelNames,
    installGuidance,
    statusTone,
    displayOrMissing,
    requestAction,
    setQueuePaused,
    saveMaxConcurrency,
    savePollSeconds,
    copyAuthorization,
    openAuthorizationBrowser,
    openOfficialDocs,
    checkAuthorization,
  };
}

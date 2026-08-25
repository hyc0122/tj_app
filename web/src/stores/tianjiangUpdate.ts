import { defineStore } from "pinia";
import { computed, onScopeDispose, ref } from "vue";
import {
  checkTianjiangUpdate,
  downloadTianjiangUpdate,
  getTianjiangUpdateStatus,
  runTianjiangLocalUpdateAction,
  type TianjiangDownloadAction,
  type TianjiangLocalAction,
  type TianjiangUpdateChannel,
  type TianjiangUpdateChannelSnapshot,
  type TianjiangUpdateSnapshot,
} from "@/api/tianjiang/update";

const emptyChannel = (): TianjiangUpdateChannelSnapshot => ({
  status: "idle",
  source: "none",
  required: false,
  downloadAllowed: false,
});

const emptySnapshot = (): TianjiangUpdateSnapshot => ({
  state: "idle",
  currentVersion: "",
  stable: emptyChannel(),
  beta: emptyChannel(),
  stableRequired: false,
  loginAllowed: true,
  selectedChannel: null,
});

function normalizeChannel(
  next: Partial<TianjiangUpdateChannelSnapshot> | undefined,
): TianjiangUpdateChannelSnapshot {
  return { ...emptyChannel(), ...(next ?? {}) };
}

/** 成功 HTTP 返回的是完整快照；缺省可选字段必须被清空，不能从上一轮递归继承。 */
function normalizeSnapshot(next: Partial<TianjiangUpdateSnapshot>): TianjiangUpdateSnapshot {
  return {
    ...emptySnapshot(),
    ...next,
    stable: normalizeChannel(next.stable),
    beta: normalizeChannel(next.beta),
    selectedChannel: next.selectedChannel ?? null,
  };
}

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return "更新失败，请重试";
}

function errorSnapshot(error: unknown): Partial<TianjiangUpdateSnapshot> | null {
  if (!error || typeof error !== "object") return null;
  const data = (error as { data?: unknown }).data;
  return data && typeof data === "object" ? data as Partial<TianjiangUpdateSnapshot> : null;
}

export default defineStore("tianjiang-update", () => {
  const snapshot = ref<TianjiangUpdateSnapshot>(emptySnapshot());
  const busy = ref(false);
  const actionMessage = ref("");
  const actionError = ref("");
  let operationInFlight: {
    key: string;
    shareableCheck: boolean;
    promise: Promise<TianjiangUpdateSnapshot>;
  } | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingStableRetry = false;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let statusRequestInFlight = false;
  let disposed = false;

  const stableRequired = computed(() => snapshot.value.stableRequired);

  function applySnapshot(next: Partial<TianjiangUpdateSnapshot>): TianjiangUpdateSnapshot {
    snapshot.value = normalizeSnapshot(next);
    return snapshot.value;
  }

  function applyFailure(
    error: unknown,
    fromServer: Partial<TianjiangUpdateSnapshot> | null,
    failClosed: boolean,
  ): TianjiangUpdateSnapshot {
    if (fromServer) {
      snapshot.value = normalizeSnapshot({
        ...fromServer,
        state: "error",
        errorMessage: errorText(error),
      });
      return snapshot.value;
    }
    // 中文注释：本地 transport 没有 envelope 时保留已知强更对象，但登录检查必须失败关闭。
    snapshot.value = {
      ...snapshot.value,
      state: "error",
      errorMessage: errorText(error),
      ...(failClosed ? { loginAllowed: false } : {}),
    };
    return snapshot.value;
  }

  function visibleSuccess(next: TianjiangUpdateSnapshot): string {
    if (next.state === "downloading") return "更新下载已开始";
    if (next.state === "downloaded") return "安装包下载完成";
    if (next.state === "preparing_install") return "安装请求已受理，正在安全关闭本地服务";
    if (next.state === "installing") return "安装程序已启动";
    return "更新状态已刷新";
  }

  function scheduleRetryIfNeeded(next: TianjiangUpdateSnapshot): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    // 中文注释：任一语义检查的新完整快照都取代旧重试意图，再按新快照决定是否重排。
    pendingStableRetry = false;
    if (disposed) return;
    if (!next.loginAllowed || next.stableRequired || !next.warningMessage) return;
    // 中文注释：无强制缓存的网络失败允许登录，但在后台复用同一个 Store 单飞重试。
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      requestBackgroundStableRetry();
    }, 30_000);
  }

  function requestBackgroundStableRetry(): void {
    if (disposed) return;
    if (operationInFlight) {
      // 中文注释：下载或安装占用状态机时保留重试意图，动作结束后再发真实 Stable 检查。
      pendingStableRetry = true;
      return;
    }
    pendingStableRetry = false;
    void checkLoginStable();
  }

  function flushPendingStableRetry(): void {
    if (disposed || !pendingStableRetry) return;
    queueMicrotask(() => {
      // 新动作抢先开始时继续保留 pending，由该动作 finally 再次排队。
      if (disposed || operationInFlight || !pendingStableRetry) return;
      pendingStableRetry = false;
      void checkLoginStable();
    });
  }

  function runSingleFlight(
    key: string,
    shareableCheck: boolean,
    request: () => Promise<TianjiangUpdateSnapshot>,
    options: { failClosed: boolean; backgroundRetry: boolean },
  ): Promise<TianjiangUpdateSnapshot> {
    if (disposed) return Promise.reject(new Error("更新状态实例已销毁"));
    if (operationInFlight) {
      if (
        shareableCheck
        && operationInFlight.shareableCheck
        && operationInFlight.key === key
      ) {
        return operationInFlight.promise;
      }
      return Promise.reject(new Error("已有其他更新操作正在进行，请稍后重试"));
    }
    busy.value = true;
    actionError.value = "";
    const operation = request()
      .then((next) => {
        if (disposed) return normalizeSnapshot(next);
        const applied = applySnapshot(next);
        actionMessage.value = visibleSuccess(applied);
        if (options.backgroundRetry) scheduleRetryIfNeeded(applied);
        return applied;
      })
      .catch((error: unknown) => {
        if (disposed) return normalizeSnapshot(errorSnapshot(error) ?? snapshot.value);
        actionError.value = errorText(error);
        actionMessage.value = "";
        const fromServer = errorSnapshot(error);
        return applyFailure(error, fromServer, options.failClosed);
      })
      .finally(() => {
        if (operationInFlight?.promise === operation) {
          operationInFlight = null;
          busy.value = false;
          flushPendingStableRetry();
        }
      });
    operationInFlight = { key, shareableCheck, promise: operation };
    return operation;
  }

  function checkLoginStable(): Promise<TianjiangUpdateSnapshot> {
    return runSingleFlight(
      "check-login-stable",
      true,
      () => checkTianjiangUpdate("check-login-stable"),
      { failClosed: true, backgroundRetry: true },
    );
  }

  function check(): Promise<TianjiangUpdateSnapshot> {
    return runSingleFlight(
      "check",
      true,
      () => checkTianjiangUpdate("check"),
      { failClosed: false, backgroundRetry: true },
    );
  }

  function download(
    action: TianjiangDownloadAction,
    channel: TianjiangUpdateChannel,
  ): Promise<TianjiangUpdateSnapshot> {
    const accepted = runSingleFlight(
      `${action}:${channel}`,
      false,
      () => downloadTianjiangUpdate(action, channel),
      { failClosed: false, backgroundRetry: false },
    );
    void accepted.then((next) => {
      if (next.state === "downloading") startStatusPolling();
    });
    return accepted;
  }

  function runLocalAction(action: TianjiangLocalAction): Promise<TianjiangUpdateSnapshot> {
    const operation = runSingleFlight(
      action,
      false,
      () => runTianjiangLocalUpdateAction(action),
      { failClosed: false, backgroundRetry: false },
    );
    void operation.then((next) => {
      if (next.state === "preparing_install") startStatusPolling();
      else if (next.state !== "downloading") stopStatusPolling();
    });
    return operation;
  }

  function stopStatusPolling(): void {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = undefined;
  }

  function scheduleStatusPoll(): void {
    stopStatusPolling();
    if (disposed) return;
    statusTimer = setTimeout(() => { void pollStatus(); }, 500);
  }

  function startStatusPolling(): void {
    if (!isBackgroundUpdateState(snapshot.value.state) || statusTimer || statusRequestInFlight) return;
    scheduleStatusPoll();
  }

  async function pollStatus(): Promise<void> {
    statusTimer = undefined;
    if (statusRequestInFlight || !isBackgroundUpdateState(snapshot.value.state)) return;
    statusRequestInFlight = true;
    try {
      const next = applySnapshot(await getTianjiangUpdateStatus());
      if (next.state === "downloaded") actionMessage.value = "安装包下载完成";
      if (next.state === "error") actionError.value = next.errorMessage || "更新下载失败";
    } catch (error) {
      actionError.value = errorText(error);
    } finally {
      statusRequestInFlight = false;
      if (!disposed && isBackgroundUpdateState(snapshot.value.state)) scheduleStatusPoll();
      else stopStatusPolling();
    }
  }

  // 中文注释：Pinia Store 被销毁或 HMR 替换时清理全部定时器，禁止旧实例继续请求。
  onScopeDispose(() => {
    disposed = true;
    pendingStableRetry = false;
    stopStatusPolling();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
  });

  function isBackgroundUpdateState(state: TianjiangUpdateSnapshot["state"]): boolean {
    return state === "downloading" || state === "preparing_install";
  }

  return {
    snapshot,
    busy,
    actionMessage,
    actionError,
    stableRequired,
    checkLoginStable,
    check,
    download,
    runLocalAction,
    stopStatusPolling,
  };
});

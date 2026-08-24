import { onScopeDispose, watch, watchEffect, type Ref } from "vue";

interface StoryboardGenerationPollingInput {
  projectUuid: Ref<string>;
  refreshShots: () => Promise<boolean>;
  hasActiveTasks: () => boolean;
  intervalMs?: number;
  onAcceptedRefreshError?: () => void;
}

const ACTIVE_STORYBOARD_GENERATION_STATUSES = new Set([
  "queued",
  "claiming",
  "recovering",
  "running",
  "submitting",
  "submitted",
  "polling",
  "querying",
  "provider_active",
  "provider_completed",
  "downloading",
  "validating",
  "waiting_project_lock",
  "postprocess_failed_retryable",
]);

/** 前后端持久状态进入任一可继续推进阶段时，页面必须保持轮询。 */
export function isStoryboardGenerationTaskStatusActive(status: string): boolean {
  return ACTIVE_STORYBOARD_GENERATION_STATUSES.has(String(status ?? "").trim().toLowerCase());
}

/**
 * 分镜生成状态轮询：单定时器、单在途请求，项目切换或组件卸载后旧 Promise 不得重启轮询。
 */
export function useStoryboardGenerationPolling(input: StoryboardGenerationPollingInput): {
  start(): void;
  notifyAccepted(): void;
  stop(): void;
} {
  const intervalMs = Math.max(100, Number(input.intervalMs) || 5_000);
  let timer: ReturnType<typeof setInterval> | undefined;
  let currentRun: Promise<void> | undefined;
  let currentRunServesAccepted = false;
  let epoch = 0;
  let disposed = false;
  let acceptedRefreshRequested = false;

  function clearTimer(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  }

  function tick(): void {
    if (disposed || currentRun) return;
    const runEpoch = epoch;
    const servesAccepted = acceptedRefreshRequested;
    if (servesAccepted) acceptedRefreshRequested = false;
    currentRunServesAccepted = servesAccepted;
    let refreshSucceeded = false;
    const run = (async () => {
      try {
        refreshSucceeded = await input.refreshShots();
      } catch {
        refreshSucceeded = false;
      }
    })();
    currentRun = run;
    // 中文注释：finally 只释放它自己登记的 Promise；旧项目响应不能清理新项目的在途标记或定时器。
    void run.finally(() => {
      if (currentRun === run) {
        currentRun = undefined;
        currentRunServesAccepted = false;
      }
      if (disposed || runEpoch !== epoch) return;
      if (!refreshSucceeded && servesAccepted) {
        input.onAcceptedRefreshError?.();
      }
      if (acceptedRefreshRequested) {
        // 中文注释：旧刷新无法证明新受理任务已可见；它结束后必须立即补跑一次，仍保持单请求无重叠。
        tick();
        return;
      }
      if (refreshSucceeded && !input.hasActiveTasks()) clearTimer();
    });
  }

  function start(): void {
    if (disposed || timer) return;
    timer = setInterval(tick, intervalMs);
  }

  function notifyAccepted(): void {
    if (disposed) return;
    // 中文注释：同一受理刷新在途时重复通知只合并一次；普通旧刷新在途时则登记必须补跑。
    if (!currentRun || !currentRunServesAccepted) acceptedRefreshRequested = true;
    start();
    // 中文注释：耐久受理后立即读取一次 queued 状态；后续固定五秒且绝不与本次请求重叠。
    tick();
  }

  function stop(): void {
    epoch += 1;
    clearTimer();
    // 中文注释：旧请求不能取消，但必须从新项目的 in-flight 槽位分离；其 finally 仍由 Promise 身份保护。
    currentRun = undefined;
    currentRunServesAccepted = false;
    acceptedRefreshRequested = false;
  }

  watch(input.projectUuid, () => stop(), { flush: "sync" });
  watchEffect(() => {
    if (input.hasActiveTasks()) start();
    else if (!currentRun) clearTimer();
  });
  onScopeDispose(() => {
    disposed = true;
    stop();
  });

  return { start, notifyAccepted, stop };
}

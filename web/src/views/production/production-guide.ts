import { ref, watch, type Ref } from "vue";

export const PRODUCTION_GUIDE_ROUTE = "/tianjiang/client-state/productionGuide";
export const PRODUCTION_GUIDE_VERSION = 1;
export const PRODUCTION_GUIDE_SAVE_ERROR = "新手引导完成状态保存失败，请重试";

export interface ProductionGuideHttpClient {
  get(url: string): Promise<unknown>;
  put(url: string, body: unknown): Promise<unknown>;
}

export interface ProductionGuideController {
  current: Ref<number>;
  errorMessage: Ref<string>;
  initialize(): Promise<void>;
  complete(): Promise<boolean>;
  replayOnce(): void;
}

function completedRevisionFromResponse(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as { data?: unknown };
  if (!payload.data || typeof payload.data !== "object") return null;
  const completedRevision = (payload.data as { completedRevision?: unknown })
    .completedRevision;
  return typeof completedRevision === "number"
    && Number.isInteger(completedRevision)
    && completedRevision >= 0
    ? completedRevision
    : null;
}

/**
 * 视频生产引导由 App 持久化；读取失败时保持隐藏，不能阻塞工作台主体。
 */
export function createProductionGuideController(
  client: ProductionGuideHttpClient,
): ProductionGuideController {
  const current = ref(-1);
  const errorMessage = ref("");
  let initializeGeneration = 0;
  let lastVisibleStep = 0;

  watch(
    current,
    (step) => {
      // 中文注释：组件可能在结束回调前先写入 -1，必须保留最后可见步骤供保存失败时重试。
      if (Number.isInteger(step) && step >= 0) lastVisibleStep = step;
    },
    { flush: "sync" },
  );

  async function initialize(): Promise<void> {
    const generation = ++initializeGeneration;
    errorMessage.value = "";
    current.value = -1;
    try {
      const response = await client.get(PRODUCTION_GUIDE_ROUTE);
      if (generation !== initializeGeneration) return;
      const completedRevision = completedRevisionFromResponse(response);
      current.value = completedRevision !== null
        && completedRevision < PRODUCTION_GUIDE_VERSION
        ? 0
        : -1;
    } catch {
      if (generation === initializeGeneration) current.value = -1;
    }
  }

  async function complete(): Promise<boolean> {
    // 中文注释：结束动作同时作废旧初始化响应，避免关闭后被迟到 GET 再次打开。
    initializeGeneration += 1;
    errorMessage.value = "";
    try {
      const response = await client.put(PRODUCTION_GUIDE_ROUTE, {
        completedRevision: PRODUCTION_GUIDE_VERSION,
      });
      const completedRevision = completedRevisionFromResponse(response);
      if (completedRevision === null || completedRevision < PRODUCTION_GUIDE_VERSION) {
        throw new Error("production guide completion was not persisted");
      }
      // 中文注释：只有服务端确认持久化成功，界面才进入已完成状态。
      current.value = -1;
      return true;
    } catch {
      // 中文注释：不暴露底层异常；恢复最后步骤，让 finish/skip/close 都能原位重试。
      errorMessage.value = PRODUCTION_GUIDE_SAVE_ERROR;
      current.value = lastVisibleStep;
      return false;
    }
  }

  function replayOnce(): void {
    // 中文注释：手动重播只影响本次页面，并作废旧 GET；不清除服务端完成版本。
    initializeGeneration += 1;
    errorMessage.value = "";
    current.value = 0;
  }

  return { current, errorMessage, initialize, complete, replayOnce };
}

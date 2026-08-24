/**
 * 决策层运行结果与 markLegacyMutation 门禁 / 幂等 durable markOnce。
 */

export interface DecisionRunResult {
  /** 本轮决策是否在项目库成功提交过至少一次 plan 事务 */
  planCommitted: boolean;
}

/** route 仅在真实项目事务提交后才 markLegacyMutation */
export function shouldMarkLegacyMutationAfterDecision(result: DecisionRunResult | null | undefined): boolean {
  return result?.planCommitted === true;
}

/**
 * 幂等项目事务 mutation 标记器。
 * - recordIntent：持久化 intent（必须在 runtime mark 前成功）
 * - markRuntime：调用 syncCoordinator.markLegacyMutation
 * - 若 intent 已写而 runtime mark 失败：satisfiedByIntent=true，仍算本轮可结束
 * - finally 可补偿 retry markRuntime
 */
export function createIdempotentPlanCommitMarker(options: {
  /** 持久化 intent；失败则本轮不得宣称已登记 */
  recordIntent: () => void;
  /** 运行时 dirty 登记 */
  markRuntime: () => void;
  /** runtime mark 成功后可选清理（通常保留 intent 直到同步成功） */
  onRuntimeMarked?: () => void;
}): {
  markOnce: () => void;
  /** runtime dirty 已成功 */
  marked: boolean;
  /** intent 已落盘 */
  intentRecorded: boolean;
  /** runtime mark 失败待补偿 */
  pendingRetry: boolean;
  /** intent 已写或 runtime 已 mark：handler 可结束 */
  isSatisfied: () => boolean;
  needsCompensation: () => boolean;
} {
  let marked = false;
  let intentRecorded = false;
  let pendingRetry = false;

  return {
    get marked() {
      return marked;
    },
    get intentRecorded() {
      return intentRecorded;
    },
    get pendingRetry() {
      return pendingRetry;
    },
    isSatisfied() {
      return marked || intentRecorded;
    },
    needsCompensation() {
      // intent 已写但 runtime 未 mark，或 mark 曾失败
      return intentRecorded && !marked;
    },
    markOnce() {
      if (marked) return;
      if (!intentRecorded) {
        options.recordIntent();
        intentRecorded = true;
      }
      try {
        options.markRuntime();
        marked = true;
        pendingRetry = false;
        try {
          options.onRuntimeMarked?.();
        } catch {
          // 清理失败不回滚 dirty
        }
      } catch (err) {
        pendingRetry = true;
        throw err;
      }
    },
  };
}

export type IdempotentPlanCommitMarker = ReturnType<typeof createIdempotentPlanCommitMarker>;

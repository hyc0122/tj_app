import type { CanvasSaveComparableSnapshot } from './resolveCanvasDirtyAfterSave'
import {
  reconcileCompletedCanvasSave,
  resolveCanvasDirtyAfterSave,
} from './resolveCanvasDirtyAfterSave'

/**
 * 保存请求完成后的唯一状态收敛入口。
 * 它按顺序更新确认基线、回填冲突快照并读取真实 store，再落定未保存状态。
 */
export function applyCompletedCanvasSave(input: {
  rebased: boolean
  savingMutationRevision: number
  currentMutationRevision: number
  savingSnapshot: CanvasSaveComparableSnapshot
  acknowledgedSnapshot: CanvasSaveComparableSnapshot
  readCurrentSnapshot: () => CanvasSaveComparableSnapshot
  setAcknowledgedSnapshot: (snapshot: CanvasSaveComparableSnapshot) => void
  applyRebasedSnapshot: (snapshot: CanvasSaveComparableSnapshot) => boolean
  setDirty: (dirty: boolean) => void
}): {
  snapshotToApply: CanvasSaveComparableSnapshot | null
  dirtyAfterSave: boolean
} {
  const currentSnapshot = input.readCurrentSnapshot()
  const reconciliation = reconcileCompletedCanvasSave({
    rebased: input.rebased,
    savingMutationRevision: input.savingMutationRevision,
    currentMutationRevision: input.currentMutationRevision,
    savingSnapshot: input.savingSnapshot,
    currentSnapshot,
    acknowledgedSnapshot: input.acknowledgedSnapshot,
  })

  input.setAcknowledgedSnapshot(input.acknowledgedSnapshot)
  if (reconciliation.snapshotToApply) {
    input.applyRebasedSnapshot(reconciliation.snapshotToApply)
  }
  const currentSnapshotAfterApply = input.readCurrentSnapshot()
  const dirtyAfterSave = resolveCanvasDirtyAfterSave({
    savingMutationRevision: input.savingMutationRevision,
    currentMutationRevision: input.currentMutationRevision,
    savedSnapshot: input.acknowledgedSnapshot,
    currentSnapshot: currentSnapshotAfterApply,
  })
  input.setDirty(dirtyAfterSave)
  return {
    snapshotToApply: reconciliation.snapshotToApply,
    dirtyAfterSave,
  }
}

import type { Edge, Node } from '@xyflow/react'
import { hasCreationSessionProgressChanged } from './creationSessionPersistence'
import { rebaseCanvasFlowOnConflict } from './flowConflictRebase'
import { persistedGraphContentKey } from './persistedGraphContentKey'

export type CanvasSaveComparableSnapshot = {
  nodes: readonly Node[]
  edges: readonly Edge[]
  sceneCreationProgress?: unknown
}

/**
 * 只有保存开始后没有新的作者修订时，才能把服务端 rebase 快照回填到当前编辑器。
 * 否则应只更新服务端确认基线，让外层脏状态比较保留保存期间的新编辑。
 */
export function shouldApplyRebasedCanvasSnapshot(input: {
  savingMutationRevision: number
  currentMutationRevision: number
  savingSnapshot: CanvasSaveComparableSnapshot
  currentSnapshot: CanvasSaveComparableSnapshot
}): boolean {
  return !resolveCanvasDirtyAfterSave({
    savingMutationRevision: input.savingMutationRevision,
    currentMutationRevision: input.currentMutationRevision,
    savedSnapshot: input.savingSnapshot,
    currentSnapshot: input.currentSnapshot,
  })
}

/**
 * 保存期间出现真实编辑时，把这段 live delta 再叠加到服务端已确认快照。
 * 这样既不会丢用户刚输入的内容，也不会在下一次保存时误删并发写入的服务端节点。
 */
export function mergeLiveEditsOntoRebasedCanvasSnapshot(input: {
  savingSnapshot: CanvasSaveComparableSnapshot
  currentSnapshot: CanvasSaveComparableSnapshot
  rebasedSnapshot: CanvasSaveComparableSnapshot
}): CanvasSaveComparableSnapshot {
  return rebaseCanvasFlowOnConflict({
    base: {
      nodes: [...input.savingSnapshot.nodes],
      edges: [...input.savingSnapshot.edges],
      sceneCreationProgress: input.savingSnapshot.sceneCreationProgress,
    },
    local: {
      nodes: [...input.currentSnapshot.nodes],
      edges: [...input.currentSnapshot.edges],
      sceneCreationProgress: input.currentSnapshot.sceneCreationProgress,
    },
    server: {
      nodes: [...input.rebasedSnapshot.nodes],
      edges: [...input.rebasedSnapshot.edges],
      sceneCreationProgress: input.rebasedSnapshot.sceneCreationProgress,
    },
  })
}

/**
 * 把保存响应、冲突 rebase 和保存期间的实时编辑收敛为一个结果。
 * 调用方必须使用 snapshotToApply 回填画布；dirtyAfterSave 表示是否还有下一轮待保存内容。
 */
export function reconcileCompletedCanvasSave(input: {
  rebased: boolean
  savingMutationRevision: number
  currentMutationRevision: number
  savingSnapshot: CanvasSaveComparableSnapshot
  currentSnapshot: CanvasSaveComparableSnapshot
  acknowledgedSnapshot: CanvasSaveComparableSnapshot
}): {
  snapshotToApply: CanvasSaveComparableSnapshot | null
  dirtyAfterSave: boolean
} {
  const snapshotToApply = input.rebased
    ? shouldApplyRebasedCanvasSnapshot({
      savingMutationRevision: input.savingMutationRevision,
      currentMutationRevision: input.currentMutationRevision,
      savingSnapshot: input.savingSnapshot,
      currentSnapshot: input.currentSnapshot,
    })
      ? input.acknowledgedSnapshot
      : mergeLiveEditsOntoRebasedCanvasSnapshot({
        savingSnapshot: input.savingSnapshot,
        currentSnapshot: input.currentSnapshot,
        rebasedSnapshot: input.acknowledgedSnapshot,
      })
    : null
  return {
    snapshotToApply,
    dirtyAfterSave: resolveCanvasDirtyAfterSave({
      savingMutationRevision: input.savingMutationRevision,
      currentMutationRevision: input.currentMutationRevision,
      savedSnapshot: input.acknowledgedSnapshot,
      currentSnapshot: snapshotToApply ?? input.currentSnapshot,
    }),
  }
}

/**
 * 保存完成后判断是否仍有真正未落盘的作者内容。
 *
 * mutation revision 不能作为唯一依据：创作进度由外部 store 写入后，React effect
 * 可能尚未来得及递增修订。最终必须始终与服务端确认快照做语义比较。
 */
export function resolveCanvasDirtyAfterSave(input: {
  savingMutationRevision: number
  currentMutationRevision: number
  savedSnapshot: CanvasSaveComparableSnapshot
  currentSnapshot: CanvasSaveComparableSnapshot
}): boolean {
  const graphChanged = persistedGraphContentKey(
    input.currentSnapshot.nodes,
    input.currentSnapshot.edges,
  ) !== persistedGraphContentKey(
    input.savedSnapshot.nodes,
    input.savedSnapshot.edges,
  )
  if (graphChanged) return true

  return hasCreationSessionProgressChanged(
    JSON.stringify(input.currentSnapshot.sceneCreationProgress ?? null),
    input.savedSnapshot.sceneCreationProgress,
  )
}

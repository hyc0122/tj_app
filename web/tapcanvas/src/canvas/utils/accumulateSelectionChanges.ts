import type { Node, NodeChange } from '@xyflow/react'

/**
 * 累积「纯选中」变更批次，供防抖提交到业务 store 时一次性写入。
 *
 * React Flow 的框选是增量下发的：每个指针帧只发这一帧里 selected 真的翻转的那些节点
 * （见 getSelectionChanges 对上一帧集合做 diff）。因此把缓冲区直接赋值成最新那批
 * （而不是累积）会只留下最后一帧的增量——框中的其他节点永远不会带着 selected:true
 * 进业务 store，画布视觉（React Flow 内部 store 是逐批累积的）与业务 store 就此分叉，
 * AI 对话面板等读业务 store 的消费方拿到的是残缺选中集。
 *
 * 同一节点后来的变更覆盖先前的（最后一次才是它的终态），首次出现的顺序保持不变。
 */
export function accumulateSelectionChanges(
  pending: readonly NodeChange<Node>[],
  incoming: readonly NodeChange<Node>[],
): NodeChange<Node>[] {
  if (!pending.length) return [...incoming]

  const merged = [...pending]
  const indexById = new Map<string, number>()
  merged.forEach((change, index) => {
    const id = (change as { id?: unknown }).id
    if (typeof id === 'string') indexById.set(id, index)
  })

  for (const change of incoming) {
    const id = (change as { id?: unknown }).id
    if (typeof id !== 'string') {
      merged.push(change)
      continue
    }
    const existing = indexById.get(id)
    if (existing === undefined) {
      indexById.set(id, merged.length)
      merged.push(change)
      continue
    }
    merged[existing] = change
  }

  return merged
}

/**
 * 在确认发生普通点击时，立即把 React Flow 已产生的选中变化提交到业务 store。
 *
 * 框选仍走防抖批量提交；只有确认点击需要同步提交，避免完整节点挂载后的数据回写
 * 使用旧的 selected 状态覆盖 React Flow 内部已经选中的节点。
 */
export function flushPendingSelectionCommit<NodeType extends Node>(input: {
  pendingRef: { current: NodeChange<NodeType>[] }
  timerRef: { current: ReturnType<typeof setTimeout> | null }
  commit: (changes: NodeChange<NodeType>[]) => void
  cancelTimer?: (timer: ReturnType<typeof setTimeout>) => void
}): void {
  const timer = input.timerRef.current
  if (timer !== null) {
    ;(input.cancelTimer ?? clearTimeout)(timer)
    input.timerRef.current = null
  }

  const pending = input.pendingRef.current
  input.pendingRef.current = []
  if (pending.length) input.commit(pending)
}

/**
 * 为框选安排一次延迟提交。
 *
 * React Flow 内部 store 仍同步更新视觉选中态，业务 store 只在 120ms 窗口结束后批量写入；
 * 普通点击会调用 flushPendingSelectionCommit 立即冲刷同一缓冲区。
 */
export function schedulePendingSelectionCommit<NodeType extends Node>(input: {
  pendingRef: { current: NodeChange<NodeType>[] }
  timerRef: { current: ReturnType<typeof setTimeout> | null }
  commit: (changes: NodeChange<NodeType>[]) => void
  shouldDefer?: () => boolean
  delayMs?: number
  scheduleTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancelTimer?: (timer: ReturnType<typeof setTimeout>) => void
}): void {
  const existingTimer = input.timerRef.current
  if (existingTimer !== null) {
    ;(input.cancelTimer ?? clearTimeout)(existingTimer)
  }

  const scheduleTimer = input.scheduleTimer ?? setTimeout
  input.timerRef.current = scheduleTimer(() => {
    input.timerRef.current = null
    if (input.shouldDefer?.()) return
    const pending = input.pendingRef.current
    input.pendingRef.current = []
    if (pending.length) input.commit(pending)
  }, input.delayMs ?? 120) as ReturnType<typeof setTimeout>
}

/**
 * 确认普通点击后，严格按“先固化选中态、再发布焦点”的顺序执行。
 * 抽成可测试的运行时契约，避免后续重构把完整节点挂载提前到选中态提交之前。
 */
export function commitConfirmedNodeSelectionAndFocus(input: {
  clickedNodeId: string
  clickedNodeType?: string | null
  hasSelectionModifier: boolean
  readSoleSelectedNodeId: () => string | null
  flushPendingSelection: () => void
  setFocusedNodeId: (nodeId: string | null) => void
  setFocusRequestedNodeId: (nodeId: string) => void
}): boolean {
  input.flushPendingSelection()
  // 冲刷会同步写入 Zustand；必须在冲刷后读取，不能继续使用点击前的旧快照。
  const soleSelectedNodeId = input.readSoleSelectedNodeId()
  const canFocusImmediately =
    !input.hasSelectionModifier
    && input.clickedNodeType !== 'groupNode'
    && soleSelectedNodeId === input.clickedNodeId
  input.setFocusedNodeId(canFocusImmediately ? input.clickedNodeId : null)
  input.setFocusRequestedNodeId(input.clickedNodeId)
  return canFocusImmediately
}

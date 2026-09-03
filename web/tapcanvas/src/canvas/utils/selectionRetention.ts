import type { Node } from '@xyflow/react'

/**
 * 把当前画布的瞬时选中态覆盖到同一画布的持久化整图回写结果上。
 *
 * selected 属于本地交互状态，不进入持久化快照。保存冲突 rebase 会返回一组
 * selected=false 的新节点；若直接替换业务 store，用户刚选中的模块就会自动失焦。
 */
export function preserveTransientNodeSelection<NodeType extends Node>(
  currentNodes: readonly NodeType[],
  replacementNodes: readonly NodeType[],
): NodeType[] {
  const selectedIds = new Set(
    currentNodes.filter((node) => node.selected === true).map((node) => node.id),
  )

  return replacementNodes.map((node) => {
    const selected = selectedIds.has(node.id)
    if (Boolean(node.selected) === selected) return node
    return { ...node, selected }
  })
}

/**
 * 确认点击后的焦点以业务 store 的唯一选中节点为真源。
 * React Flow 内部节点会在受控节点重建和尺寸测量时短暂重建，不能拿来决定是否卸载编辑面板。
 */
export function resolveConfirmedFocusedNodeId(input: {
  focusRequestedNodeId: string | null
  selectedNodes: readonly Node[]
}): string | null {
  const selectedNodes = input.selectedNodes.filter((node) => node.selected === true)
  if (selectedNodes.length !== 1) return null
  const selectedNode = selectedNodes[0]
  if (!selectedNode || selectedNode.type === 'groupNode') return null
  return selectedNode.id === input.focusRequestedNodeId ? selectedNode.id : null
}

/**
 * 完整节点已由稳定焦点状态挂载后，工具条显隐不再依赖 React Flow 的瞬时 selected 属性。
 */
export function shouldKeepFocusedNodeControlsVisible(input: {
  focused: boolean
  reactFlowSelected: boolean
  dragging: boolean
  boxSelecting: boolean
  selectedNodeCount: number
}): boolean {
  void input.reactFlowSelected
  return input.focused
    && !input.dragging
    && !input.boxSelecting
    && input.selectedNodeCount <= 1
}

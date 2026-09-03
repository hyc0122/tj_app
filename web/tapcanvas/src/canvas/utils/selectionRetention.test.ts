import { describe, expect, it } from 'vitest'
import type { Node } from '@xyflow/react'
import {
  preserveTransientNodeSelection,
  resolveConfirmedFocusedNodeId,
  shouldKeepFocusedNodeControlsVisible,
} from './selectionRetention'

const node = (id: string, selected = false, type = 'taskNode'): Node => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: {},
  selected,
})

describe('selectionRetention', () => {
  it('同一画布保存冲突回写整图时保留当前唯一选中节点', () => {
    const current = [node('image-1', true), node('director-1')]
    const rebased = [node('image-1'), node('director-1')]

    const retained = preserveTransientNodeSelection(current, rebased)

    expect(retained.find((candidate) => candidate.id === 'image-1')?.selected).toBe(true)
    expect(retained.find((candidate) => candidate.id === 'director-1')?.selected).toBe(false)
  })

  it('回写结果已删除旧节点时不会伪造选中节点', () => {
    const retained = preserveTransientNodeSelection(
      [node('deleted-node', true)],
      [node('remaining-node')],
    )

    expect(retained.every((candidate) => candidate.selected !== true)).toBe(true)
  })

  it('确认点击后的焦点以业务 store 的唯一选中节点为准', () => {
    expect(resolveConfirmedFocusedNodeId({
      focusRequestedNodeId: 'image-1',
      selectedNodes: [node('image-1', true), node('director-1')],
    })).toBe('image-1')

    expect(resolveConfirmedFocusedNodeId({
      focusRequestedNodeId: 'image-1',
      selectedNodes: [node('image-1', true), node('director-1', true)],
    })).toBeNull()
  })

  it('完整模块已聚焦时不受 React Flow 瞬时 selected=false 影响', () => {
    expect(shouldKeepFocusedNodeControlsVisible({
      focused: true,
      reactFlowSelected: false,
      dragging: false,
      boxSelecting: false,
      selectedNodeCount: 1,
    })).toBe(true)

    expect(shouldKeepFocusedNodeControlsVisible({
      focused: false,
      reactFlowSelected: true,
      dragging: false,
      boxSelecting: false,
      selectedNodeCount: 1,
    })).toBe(false)
  })
})

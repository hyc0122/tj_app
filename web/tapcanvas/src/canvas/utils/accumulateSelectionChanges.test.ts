import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Node, NodeChange } from '@xyflow/react'
import { accumulateSelectionChanges } from './accumulateSelectionChanges'
import * as selectionChangeHelpers from './accumulateSelectionChanges'

const select = (id: string, selected: boolean): NodeChange<Node> => ({ id, type: 'select', selected })

describe('accumulateSelectionChanges', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('累积框选逐帧下发的增量批次，而不是只保留最后一批', () => {
    // React Flow 框选每帧只发本帧翻转的节点。覆盖式赋值会让 a/b 永远进不了业务 store。
    let pending: NodeChange<Node>[] = []
    pending = accumulateSelectionChanges(pending, [select('a', true)])
    pending = accumulateSelectionChanges(pending, [select('b', true)])
    pending = accumulateSelectionChanges(pending, [select('c', true)])

    expect(pending).toEqual([select('a', true), select('b', true), select('c', true)])
  })

  it('同一节点的后续变更覆盖先前的（缩小框选时取消选中生效）', () => {
    let pending = accumulateSelectionChanges([], [select('a', true), select('b', true)])
    pending = accumulateSelectionChanges(pending, [select('b', false)])

    expect(pending).toEqual([select('a', true), select('b', false)])
  })

  it('覆盖时保持节点首次出现的顺序，不重复追加', () => {
    let pending = accumulateSelectionChanges([], [select('a', true), select('b', true)])
    pending = accumulateSelectionChanges(pending, [select('a', false), select('c', true)])

    expect(pending.map((change) => (change as { id: string }).id)).toEqual(['a', 'b', 'c'])
    expect(pending[0]).toEqual(select('a', false))
  })

  it('缓冲区为空时返回新数组副本，不与入参共享引用', () => {
    const incoming = [select('a', true)]
    const result = accumulateSelectionChanges([], incoming)

    expect(result).toEqual(incoming)
    expect(result).not.toBe(incoming)
  })

  it('不改动传入的缓冲区数组（调用方持有的 ref 不被就地污染）', () => {
    const pending = [select('a', true)]
    accumulateSelectionChanges(pending, [select('b', true)])

    expect(pending).toEqual([select('a', true)])
  })

  it('确认点击节点时立即提交缓冲选中态，后续节点数据更新不会把焦点覆盖掉', () => {
    type FlushSelectionCommit = (input: {
      pendingRef: { current: NodeChange<Node>[] }
      timerRef: { current: ReturnType<typeof setTimeout> | null }
      commit: (changes: NodeChange<Node>[]) => void
      cancelTimer: (timer: ReturnType<typeof setTimeout>) => void
    }) => void
    const flushPendingSelectionCommit = (
      selectionChangeHelpers as typeof selectionChangeHelpers & {
        flushPendingSelectionCommit?: FlushSelectionCommit
      }
    ).flushPendingSelectionCommit

    // 中文注释：该断言先锁住缺失的同步提交能力；实现存在后继续验证真实状态结果。
    expect(flushPendingSelectionCommit).toBeTypeOf('function')
    if (!flushPendingSelectionCommit) return

    let businessNodes = [{
      id: 'image-1',
      selected: false,
      data: { kind: 'image', imageModel: '' },
    }]
    const pendingRef = { current: [select('image-1', true)] }
    const timer = setTimeout(() => undefined, 1000)
    const timerRef = { current: timer as ReturnType<typeof setTimeout> | null }
    const cancelTimer = vi.fn((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle))

    flushPendingSelectionCommit({
      pendingRef,
      timerRef,
      cancelTimer,
      commit: (changes) => {
        businessNodes = businessNodes.map((node) => {
          const change = changes.find((candidate) => candidate.type === 'select' && candidate.id === node.id)
          return change?.type === 'select' ? { ...node, selected: change.selected } : node
        })
      },
    })

    // 模拟节点完整面板挂载后，模型目录回写节点数据。
    businessNodes = businessNodes.map((node) => ({
      ...node,
      data: { ...node.data, imageModel: 'atlas:gpt-image-real' },
    }))

    expect(cancelTimer).toHaveBeenCalledWith(timer)
    expect(timerRef.current).toBeNull()
    expect(pendingRef.current).toEqual([])
    expect(businessNodes[0]?.selected).toBe(true)
  })

  it('普通框选在 119ms 前不提交，并在 120ms 时批量提交', () => {
    vi.useFakeTimers()
    type ScheduleSelectionCommit = (input: {
      pendingRef: { current: NodeChange<Node>[] }
      timerRef: { current: ReturnType<typeof setTimeout> | null }
      commit: (changes: NodeChange<Node>[]) => void
      shouldDefer?: () => boolean
      delayMs?: number
    }) => void
    const schedulePendingSelectionCommit = (
      selectionChangeHelpers as typeof selectionChangeHelpers & {
        schedulePendingSelectionCommit?: ScheduleSelectionCommit
      }
    ).schedulePendingSelectionCommit

    expect(schedulePendingSelectionCommit).toBeTypeOf('function')
    if (!schedulePendingSelectionCommit) return

    const commit = vi.fn()
    const pendingRef = { current: [select('a', true), select('b', true)] }
    const timerRef = { current: null as ReturnType<typeof setTimeout> | null }

    schedulePendingSelectionCommit({ pendingRef, timerRef, commit, delayMs: 120 })
    vi.advanceTimersByTime(119)
    expect(commit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith([select('a', true), select('b', true)])
    expect(pendingRef.current).toEqual([])
    expect(timerRef.current).toBeNull()
  })

  it('确认点击会取消尚未触发的框选定时器并立即提交', () => {
    vi.useFakeTimers()
    const commit = vi.fn()
    const pendingRef = { current: [select('image-1', true)] }
    const timerRef = { current: null as ReturnType<typeof setTimeout> | null }
    const schedulePendingSelectionCommit = (
      selectionChangeHelpers as typeof selectionChangeHelpers & {
        schedulePendingSelectionCommit?: (input: {
          pendingRef: { current: NodeChange<Node>[] }
          timerRef: { current: ReturnType<typeof setTimeout> | null }
          commit: (changes: NodeChange<Node>[]) => void
        }) => void
      }
    ).schedulePendingSelectionCommit

    expect(schedulePendingSelectionCommit).toBeTypeOf('function')
    if (!schedulePendingSelectionCommit) return
    schedulePendingSelectionCommit({ pendingRef, timerRef, commit })

    selectionChangeHelpers.flushPendingSelectionCommit({ pendingRef, timerRef, commit })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith([select('image-1', true)])

    vi.advanceTimersByTime(120)
    expect(commit).toHaveBeenCalledTimes(1)
  })
})

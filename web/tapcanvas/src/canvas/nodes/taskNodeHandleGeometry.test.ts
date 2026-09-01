import { describe, expect, it } from 'vitest'
import { Position } from '@xyflow/react'
import {
  HANDLE_HORIZONTAL_OFFSET,
  HANDLE_VERTICAL_OFFSET,
  buildHandleStyle,
} from './taskNodeHelpers'

describe('节点连接点几何', () => {
  it('水平/垂直偏移必须为 0，使 Handle 中心贴合边框', () => {
    expect(HANDLE_HORIZONTAL_OFFSET).toBe(0)
    expect(HANDLE_VERTICAL_OFFSET).toBe(0)
  })

  it('左右上下 Handle 的定位贴边且缩放后仍用同一偏移', () => {
    const layout = new Map<string, { top?: string; left?: string }>([
      ['in', { top: '50%' }],
      ['out', { top: '50%' }],
      ['top', { left: '50%' }],
      ['bottom', { left: '50%' }],
    ])
    const left = buildHandleStyle({ id: 'in', pos: Position.Left }, layout)
    const right = buildHandleStyle({ id: 'out', pos: Position.Right }, layout)
    const top = buildHandleStyle({ id: 'top', pos: Position.Top }, layout)
    const bottom = buildHandleStyle({ id: 'bottom', pos: Position.Bottom }, layout)
    expect(Math.abs(Number(left.left))).toBe(0)
    expect(Math.abs(Number(right.right))).toBe(0)
    expect(Math.abs(Number(top.top))).toBe(0)
    expect(Math.abs(Number(bottom.bottom))).toBe(0)
  })
})

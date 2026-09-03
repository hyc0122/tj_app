import type { Edge, Node } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import { filterNodesForPersistence } from './serialization'

describe('filterNodesForPersistence', () => {
  it('保留尚未生成远程资源的图片和视频创作节点', () => {
    const nodes = [
      { id: 'text', type: 'taskNode', position: { x: 0, y: 0 }, data: { kind: 'text', prompt: '故事梗概' } },
      { id: 'image', type: 'taskNode', position: { x: 200, y: 0 }, data: { kind: 'image', imageModel: 'seedream' } },
      { id: 'video', type: 'taskNode', position: { x: 400, y: 0 }, data: { kind: 'video', videoModel: 'seedance' } },
    ] as Node[]
    const edges = [
      { id: 'text-image', source: 'text', target: 'image' },
      { id: 'image-video', source: 'image', target: 'video' },
    ] as Edge[]

    const persisted = filterNodesForPersistence(nodes, edges)

    expect(persisted.nodes.map((node) => node.id)).toEqual(['text', 'image', 'video'])
    expect(persisted.edges.map((edge) => edge.id)).toEqual(['text-image', 'image-video'])
  })

  it('保留正在执行的媒体节点，但仍剔除真正的悬空边', () => {
    const nodes = [
      { id: 'image', type: 'taskNode', position: { x: 0, y: 0 }, data: { kind: 'image', status: 'running' } },
      { id: 'video', type: 'taskNode', position: { x: 200, y: 0 }, data: { kind: 'video', status: 'queued' } },
    ] as Node[]
    const edges = [
      { id: 'valid', source: 'image', target: 'video' },
      { id: 'dangling', source: 'image', target: 'missing' },
    ] as Edge[]

    const persisted = filterNodesForPersistence(nodes, edges)

    expect(persisted.nodes.map((node) => node.id)).toEqual(['image', 'video'])
    expect(persisted.edges.map((edge) => edge.id)).toEqual(['valid'])
  })
})

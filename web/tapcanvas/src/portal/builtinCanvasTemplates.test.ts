import { describe, expect, it } from 'vitest'
import {
  BUILTIN_CANVAS_TEMPLATE_IDS,
  cloneBuiltinCanvasTemplateGraph,
  listBuiltinCanvasTemplates,
} from './builtinCanvasTemplates'

const EXPECTED_TITLES = [
  '上传小说',
  '故事板成片',
  '一句话出图',
  '首帧转视频',
  '导演台',
  'AI 执行台',
] as const

describe('builtinCanvasTemplates', () => {
  it('始终提供六个功能完整且 ID 稳定的内置模板', () => {
    const templates = listBuiltinCanvasTemplates()
    expect(templates).toHaveLength(6)
    expect(templates.map((item) => item.templateTitle || item.name)).toEqual([...EXPECTED_TITLES])
    expect(templates.map((item) => item.id)).toEqual([...BUILTIN_CANVAS_TEMPLATE_IDS])
    for (const template of templates) {
      expect(template.id.startsWith('builtin-canvas:')).toBe(true)
      expect(/^[0-9a-f-]{36}$/i.test(template.id)).toBe(false)
      expect(template.templateCoverUrl.trim().length).toBeGreaterThan(0)
      expect(template.graph.nodes.length).toBeGreaterThan(0)
      expect(template.graph.edges.length).toBeGreaterThan(0)
    }
  })

  it('两次克隆必须重新生成节点和连线 ID，且不得共享可变状态', () => {
    const templates = listBuiltinCanvasTemplates()
    for (const template of templates) {
      const first = cloneBuiltinCanvasTemplateGraph(template)
      const second = cloneBuiltinCanvasTemplateGraph(template)
      const firstNodeIds = first.nodes.map((node) => String(node.id))
      const secondNodeIds = second.nodes.map((node) => String(node.id))
      const firstEdgeIds = first.edges.map((edge) => String(edge.id))
      const secondEdgeIds = second.edges.map((edge) => String(edge.id))
      expect(firstNodeIds).toHaveLength(template.graph.nodes.length)
      expect(new Set(firstNodeIds).size).toBe(firstNodeIds.length)
      expect(firstNodeIds.some((id) => secondNodeIds.includes(id))).toBe(false)
      expect(firstEdgeIds.some((id) => secondEdgeIds.includes(id))).toBe(false)
      expect(first.nodes.map((node) => node.data)).not.toBe(template.graph.nodes[0]?.data)
    }
  })
})

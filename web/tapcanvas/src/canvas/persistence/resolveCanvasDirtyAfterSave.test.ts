import type { Edge, Node } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import {
  mergeLiveEditsOntoRebasedCanvasSnapshot,
  reconcileCompletedCanvasSave,
  resolveCanvasDirtyAfterSave,
  shouldApplyRebasedCanvasSnapshot,
} from './resolveCanvasDirtyAfterSave'

const savedNode = {
  id: 'image-1',
  type: 'taskNode',
  position: { x: 10, y: 20 },
  selected: false,
  dragging: false,
  data: { kind: 'image', prompt: '霓虹雨夜' },
} satisfies Node

function decide(currentNodes: Node[], currentEdges: Edge[] = [], currentProgress: unknown = null): boolean {
  return resolveCanvasDirtyAfterSave({
    savingMutationRevision: 3,
    currentMutationRevision: 4,
    savedSnapshot: { nodes: [savedNode], edges: [], sceneCreationProgress: null },
    currentSnapshot: { nodes: currentNodes, edges: currentEdges, sceneCreationProgress: currentProgress },
  })
}

describe('保存成功后的画布脏状态', () => {
  it('保存期间只有选择态或拖动态变化时清除未保存标记', () => {
    expect(decide([{
      ...savedNode,
      selected: true,
      dragging: true,
      measured: { width: 320, height: 240 },
    }])).toBe(false)
  })

  it('保存期间只选中连线时清除未保存标记', () => {
    const savedEdge = {
      id: 'edge-1',
      source: 'image-1',
      target: 'image-2',
      selected: false,
    } satisfies Edge
    expect(resolveCanvasDirtyAfterSave({
      savingMutationRevision: 3,
      currentMutationRevision: 4,
      savedSnapshot: { nodes: [savedNode], edges: [savedEdge], sceneCreationProgress: null },
      currentSnapshot: { nodes: [savedNode], edges: [{ ...savedEdge, selected: true }], sceneCreationProgress: null },
    })).toBe(false)
  })

  it('保存期间只有运行时投影节点变化时清除未保存标记', () => {
    const runtimeNode = {
      id: 'runtime-1',
      type: 'taskNode',
      position: { x: 30, y: 40 },
      data: { workflowRuntimeReference: true, managedProjection: 'workflow_execution' },
    } satisfies Node
    expect(decide([savedNode, runtimeNode])).toBe(false)
  })

  it('保存请求之后发生真实提示词修改时继续显示未保存', () => {
    expect(decide([{ ...savedNode, data: { ...savedNode.data, prompt: '真实后续编辑' } }])).toBe(true)
  })

  it('保存请求之后创作进度变化时继续显示未保存', () => {
    expect(decide([savedNode], [], { currentIndex: 2 })).toBe(true)
  })

  it('保存期间没有任何修订变化时直接清除未保存标记', () => {
    expect(resolveCanvasDirtyAfterSave({
      savingMutationRevision: 3,
      currentMutationRevision: 3,
      savedSnapshot: { nodes: [savedNode], edges: [], sceneCreationProgress: null },
      currentSnapshot: { nodes: [savedNode], edges: [], sceneCreationProgress: null },
    })).toBe(false)
  })

  it('React effect 尚未递增修订时，创作进度变化仍必须保留未保存标记', () => {
    expect(resolveCanvasDirtyAfterSave({
      savingMutationRevision: 3,
      currentMutationRevision: 3,
      savedSnapshot: { nodes: [savedNode], edges: [], sceneCreationProgress: { currentIndex: 1 } },
      currentSnapshot: { nodes: [savedNode], edges: [], sceneCreationProgress: { currentIndex: 2 } },
    })).toBe(true)
  })

  it('延迟冲突保存返回时不得用 rebase 快照覆盖保存期间的新编辑', () => {
    expect(shouldApplyRebasedCanvasSnapshot({
      savingMutationRevision: 3,
      currentMutationRevision: 4,
      savingSnapshot: { nodes: [savedNode], edges: [], sceneCreationProgress: null },
      currentSnapshot: {
        nodes: [{ ...savedNode, data: { ...savedNode.data, prompt: '保存期间的新编辑' } }],
        edges: [],
        sceneCreationProgress: null,
      },
    })).toBe(false)
    expect(shouldApplyRebasedCanvasSnapshot({
      savingMutationRevision: 3,
      currentMutationRevision: 3,
      savingSnapshot: { nodes: [savedNode], edges: [], sceneCreationProgress: null },
      currentSnapshot: { nodes: [savedNode], edges: [], sceneCreationProgress: null },
    })).toBe(true)
    expect(shouldApplyRebasedCanvasSnapshot({
      savingMutationRevision: 3,
      currentMutationRevision: 4,
      savingSnapshot: { nodes: [savedNode], edges: [], sceneCreationProgress: null },
      currentSnapshot: { nodes: [{ ...savedNode, selected: true }], edges: [], sceneCreationProgress: null },
    })).toBe(true)

    const merged = mergeLiveEditsOntoRebasedCanvasSnapshot({
      savingSnapshot: { nodes: [savedNode], edges: [], sceneCreationProgress: null },
      currentSnapshot: {
        nodes: [{ ...savedNode, data: { ...savedNode.data, prompt: '保存期间的新编辑' } }],
        edges: [],
        sceneCreationProgress: { currentIndex: 3 },
      },
      rebasedSnapshot: {
        nodes: [savedNode, { id: 'server-node', type: 'taskNode', position: { x: 0, y: 0 }, data: { kind: 'text' } }],
        edges: [],
        sceneCreationProgress: null,
      },
    })
    expect(merged.nodes.map((node) => node.id)).toEqual(['image-1', 'server-node'])
    expect(merged.nodes[0]?.data).toMatchObject({ prompt: '保存期间的新编辑' })
    expect(merged.sceneCreationProgress).toEqual({ currentIndex: 3 })
  })

  it('拖动态与 durable workflow 投影同时变化时仍视为没有作者修改', () => {
    const savedWorkflowNode = {
      id: 'workflow-execution-1',
      type: 'taskNode',
      position: { x: 50, y: 60 },
      dragging: false,
      data: {
        kind: 'workflowExecution',
        workflowRuntimeReference: false,
        label: '执行占位',
        workflowStatus: 'queued',
        workflowWaitingReasonCode: 'provider_balance_required',
        workflowWaitingReasonLabel: '等待余额恢复',
      },
    } satisfies Node
    expect(resolveCanvasDirtyAfterSave({
      savingMutationRevision: 3,
      currentMutationRevision: 4,
      savedSnapshot: { nodes: [savedWorkflowNode], edges: [], sceneCreationProgress: null },
      currentSnapshot: {
        nodes: [{
          ...savedWorkflowNode,
          dragging: true,
          data: {
            ...savedWorkflowNode.data,
            workflowStatus: 'running',
            workflowWaitingReasonCode: undefined,
            workflowWaitingReasonLabel: undefined,
          },
        }],
        edges: [],
        sceneCreationProgress: null,
      },
    })).toBe(false)
  })

  it('延迟冲突保存完成后在真实保存编排中保留新编辑和服务端节点，并继续标记未保存', async () => {
    const savingSnapshot = {
      nodes: [savedNode],
      edges: [] as Edge[],
      sceneCreationProgress: null,
    }
    let currentMutationRevision = 3
    let currentSnapshot = savingSnapshot
    const serverNode = {
      id: 'server-node',
      type: 'taskNode',
      position: { x: 80, y: 90 },
      data: { kind: 'text', prompt: '服务端并发节点' },
    } satisfies Node
    const save = async (snapshot: typeof savingSnapshot, revision: number) => {
      if (revision === 3) {
        currentMutationRevision = 4
        currentSnapshot = {
          ...savingSnapshot,
          nodes: [{ ...savedNode, data: { ...savedNode.data, prompt: '保存期间的新编辑' } }],
        }
        throw Object.assign(new Error('conflict'), { status: 409, code: 'flow_revision_conflict' })
      }
      return { canvasRevision: 5, data: snapshot }
    }
    const { saveWithConflictRebase } = await import('./saveWithConflictRebase')
    const saved = await saveWithConflictRebase({
      base: savingSnapshot,
      local: savingSnapshot,
      expectedRevision: 3,
      save,
      loadLatest: async () => ({
        canvasRevision: 4,
        data: { ...savingSnapshot, nodes: [savedNode, serverNode] },
      }),
    })

    const reconciled = reconcileCompletedCanvasSave({
      rebased: saved.rebased,
      savingMutationRevision: 3,
      currentMutationRevision,
      savingSnapshot,
      currentSnapshot,
      acknowledgedSnapshot: saved.snapshot,
    })

    expect(reconciled.snapshotToApply?.nodes.map((node) => node.id)).toEqual(['image-1', 'server-node'])
    expect(reconciled.snapshotToApply?.nodes[0]?.data).toMatchObject({ prompt: '保存期间的新编辑' })
    expect(reconciled.dirtyAfterSave).toBe(true)
  })
})

import type { Edge, Node } from '@xyflow/react'
import { describe, expect, it } from 'vitest'

import { useRFStore } from '../store'
import {
  serializeCreationSessionForPersistence,
  useUIStore,
  type CreationSession,
} from '../../ui/uiStore'
import { applyCompletedCanvasSave } from './saveCompletionOrchestrator'
import { saveWithConflictRebase } from './saveWithConflictRebase'

function session(index: number): CreationSession {
  return {
    id: 'storyboard-session',
    title: 'AI 创作',
    status: 'running',
    unitType: 'storyboard_chunk',
    currentIndex: index,
    total: 8,
    currentNodeId: 'image-1',
    currentTaskId: 'task-1',
    summary: `正在生成第 ${index} 个创作单元`,
    lastError: '',
    history: [],
    updatedAt: index,
  }
}

describe('画布保存完成编排', () => {
  it('使用真实 store 保留保存期间进度和编辑，并让下一次保存携带服务端并发节点', async () => {
    const originalGraph = useRFStore.getState()
    const originalUi = useUIStore.getState()
    const savedNode = {
      id: 'image-1',
      type: 'taskNode',
      position: { x: 10, y: 20 },
      data: { kind: 'image', prompt: '保存开始时的提示词' },
    } satisfies Node
    const serverNode = {
      id: 'server-node',
      type: 'taskNode',
      position: { x: 80, y: 90 },
      data: { kind: 'text', prompt: '服务端并发节点' },
    } satisfies Node
    const savingSnapshot = {
      nodes: [savedNode],
      edges: [] as Edge[],
      sceneCreationProgress: serializeCreationSessionForPersistence(session(1)),
    }
    let acknowledgedSnapshot = savingSnapshot

    try {
      useRFStore.setState({ nodes: [savedNode], edges: [] })
      useUIStore.setState({ creationSession: session(1), isDirty: false })
      const saved = await saveWithConflictRebase({
        base: savingSnapshot,
        local: savingSnapshot,
        expectedRevision: 3,
        save: async (snapshot, revision) => {
          if (revision === 3) {
            // 模拟请求在 React effect 递增 mutation revision 之前返回冲突。
            useRFStore.setState({
              nodes: [{ ...savedNode, data: { ...savedNode.data, prompt: '保存期间的新编辑' } }],
            })
            useUIStore.setState({ creationSession: session(2) })
            throw Object.assign(new Error('conflict'), { status: 409, code: 'flow_revision_conflict' })
          }
          return { canvasRevision: 5, data: snapshot }
        },
        loadLatest: async () => ({
          canvasRevision: 4,
          data: { ...savingSnapshot, nodes: [savedNode, serverNode] },
        }),
      })

      applyCompletedCanvasSave({
        rebased: saved.rebased,
        savingMutationRevision: 3,
        currentMutationRevision: 3,
        savingSnapshot,
        acknowledgedSnapshot: saved.snapshot,
        readCurrentSnapshot: () => ({
          nodes: useRFStore.getState().nodes,
          edges: useRFStore.getState().edges,
          sceneCreationProgress: serializeCreationSessionForPersistence(useUIStore.getState().creationSession),
        }),
        setAcknowledgedSnapshot: (snapshot) => {
          acknowledgedSnapshot = snapshot as typeof savingSnapshot
        },
        applyRebasedSnapshot: (snapshot) => {
          useRFStore.setState({ nodes: [...snapshot.nodes], edges: [...snapshot.edges] })
          useUIStore.getState().restoreCreationSession(snapshot.sceneCreationProgress)
          return true
        },
        setDirty: (dirty) => useUIStore.getState().setDirty(dirty),
      })

      const nextSavePayload = {
        nodes: useRFStore.getState().nodes,
        edges: useRFStore.getState().edges,
        sceneCreationProgress: serializeCreationSessionForPersistence(useUIStore.getState().creationSession),
      }
      expect(acknowledgedSnapshot.nodes.map((node) => node.id)).toEqual(['image-1', 'server-node'])
      expect(nextSavePayload.nodes.map((node) => node.id)).toEqual(['image-1', 'server-node'])
      expect(nextSavePayload.nodes[0]?.data).toMatchObject({ prompt: '保存期间的新编辑' })
      expect(nextSavePayload.sceneCreationProgress).toMatchObject({
        unitType: 'storyboard_chunk',
        currentIndex: 2,
      })
      expect(useUIStore.getState().isDirty).toBe(true)
    } finally {
      useRFStore.setState({
        nodes: originalGraph.nodes,
        edges: originalGraph.edges,
        graphProvenanceKey: originalGraph.graphProvenanceKey,
      })
      useUIStore.setState({
        creationSession: originalUi.creationSession,
        isDirty: originalUi.isDirty,
      })
    }
  })
})

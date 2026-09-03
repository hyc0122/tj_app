import { describe, expect, it } from 'vitest'

import { hasCreationSessionProgressChanged } from './creationSessionPersistence'
import {
  serializeCreationSessionForPersistence,
  useUIStore,
  type CreationSession,
} from '../../ui/uiStore'

describe('hasCreationSessionProgressChanged', () => {
  it('persists the storyboard chunk progress emitted by the production authoring path', () => {
    const session: CreationSession = {
      id: 'storyboard-session',
      title: 'AI 创作',
      status: 'running',
      unitType: 'storyboard_chunk',
      currentIndex: 2,
      total: 8,
      currentNodeId: 'node-2',
      currentTaskId: 'task-2',
      summary: '正在生成第 2 个创作单元',
      lastError: '',
      history: [],
      updatedAt: 123,
    }

    expect(serializeCreationSessionForPersistence(session)).toMatchObject({
      id: 'storyboard-session',
      unitType: 'storyboard_chunk',
      currentIndex: 2,
      currentNodeId: 'node-2',
    })
  })

  it('does not create a new checkpoint when only updatedAt changes', () => {
    const original = useUIStore.getState().creationSession
    try {
      useUIStore.setState({ creationSession: null })
      const payload = {
        id: 'storyboard-session',
        title: 'AI 创作',
        status: 'running' as const,
        unitType: 'storyboard_chunk' as const,
        currentIndex: 2,
        total: 8,
        currentNodeId: 'node-2',
        currentTaskId: 'task-2',
        summary: '正在生成第 2 个创作单元',
        lastError: '',
      }
      useUIStore.getState().syncCreationSessionCheckpoint({ ...payload, updatedAt: 100 })
      const first = useUIStore.getState().creationSession
      useUIStore.getState().syncCreationSessionCheckpoint({ ...payload, updatedAt: 200 })
      expect(useUIStore.getState().creationSession).toBe(first)
      expect(useUIStore.getState().creationSession?.updatedAt).toBe(100)
    } finally {
      useUIStore.setState({ creationSession: original })
    }
  })

  it('does not schedule another save when the acknowledged progress is unchanged', () => {
    const progress = { stage: 'result_persistence', completed: 3 }

    expect(hasCreationSessionProgressChanged(JSON.stringify(progress), progress)).toBe(false)
  })

  it('marks only a factual progress change for persistence', () => {
    const acknowledged = { stage: 'constraint_definition', completed: 1 }
    const current = { stage: 'result_persistence', completed: 3 }

    expect(hasCreationSessionProgressChanged(JSON.stringify(current), acknowledged)).toBe(true)
  })

  it('treats missing acknowledged progress as null', () => {
    expect(hasCreationSessionProgressChanged('null', undefined)).toBe(false)
  })
})

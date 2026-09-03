import { describe, expect, it, vi } from 'vitest'
import { persistCanvasExecutionModelBeforeTask } from './canvasExecutionModelPersistence'

describe('persistCanvasExecutionModelBeforeTask', () => {
  it.each([
    ['text_to_image', 'provider:image-model'],
    ['image_edit', 'provider:image-edit-model'],
    ['text_to_video', 'provider:video-model'],
  ])('在 %s 请求前写入真实模型路由并等待保存', async (kind, requestModelKey) => {
    const calls: string[] = []
    const writeNodeModelId = vi.fn((_nodeId: string, modelId: string) => {
      calls.push(`write:${modelId}`)
    })
    const saveCurrentSnapshot = vi.fn(async () => {
      calls.push('save')
      return true
    })

    await persistCanvasExecutionModelBeforeTask({
      nodeId: 'node-1',
      request: { kind, extras: { modelKey: requestModelKey } },
      readNodeModelId: () => 'provider:old-model',
      writeNodeModelId,
      saveCurrentSnapshot,
    })

    expect(calls).toEqual([`write:${requestModelKey}`, 'save'])
    expect(writeNodeModelId).toHaveBeenCalledWith('node-1', requestModelKey)
    expect(saveCurrentSnapshot).toHaveBeenCalledTimes(1)
  })

  it('即使本地字段相同也等待一次权威保存，避免只存在于内存', async () => {
    const writeNodeModelId = vi.fn()
    const saveCurrentSnapshot = vi.fn().mockResolvedValue(true)

    await persistCanvasExecutionModelBeforeTask({
      nodeId: 'node-1',
      request: { kind: 'text_to_image', extras: { modelKey: 'provider:image-model' } },
      readNodeModelId: () => 'provider:image-model',
      writeNodeModelId,
      saveCurrentSnapshot,
    })

    expect(writeNodeModelId).not.toHaveBeenCalled()
    expect(saveCurrentSnapshot).toHaveBeenCalledTimes(1)
  })

  it('保存失败时中止执行，不能绕过服务端已保存模型校验', async () => {
    await expect(persistCanvasExecutionModelBeforeTask({
      nodeId: 'node-1',
      request: { kind: 'text_to_video', extras: { modelKey: 'provider:video-model' } },
      readNodeModelId: () => '',
      writeNodeModelId: vi.fn(),
      saveCurrentSnapshot: vi.fn().mockResolvedValue(false),
    })).rejects.toThrow('保存画布节点模型失败')
  })
})

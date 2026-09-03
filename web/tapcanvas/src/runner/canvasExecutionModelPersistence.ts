type CanvasTaskRequest = {
  kind?: unknown
  extras?: unknown
}

type ModelPersistenceInput = {
  nodeId: string
  request: CanvasTaskRequest
  readNodeModelId: (nodeId: string) => string
  writeNodeModelId: (nodeId: string, modelId: string) => void
  saveCurrentSnapshot: () => Promise<boolean>
}

const MEDIA_TASK_KINDS = new Set(['text_to_image', 'image_edit', 'text_to_video'])

function readRequestModelKey(request: CanvasTaskRequest): string {
  if (!request.extras || typeof request.extras !== 'object' || Array.isArray(request.extras)) return ''
  const value = (request.extras as Record<string, unknown>).modelKey
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 中文注释：收费预览只能使用已经写入画布快照的真实模型路由键。
 * 这里先更新节点的 modelId，再等待权威保存完成，服务端仍负责做最终防篡改比对。
 */
export async function persistCanvasExecutionModelBeforeTask(
  input: ModelPersistenceInput,
): Promise<void> {
  const kind = typeof input.request.kind === 'string' ? input.request.kind.trim() : ''
  if (!MEDIA_TASK_KINDS.has(kind)) return

  const requestModelKey = readRequestModelKey(input.request)
  if (!requestModelKey) return

  if (input.readNodeModelId(input.nodeId).trim() !== requestModelKey) {
    input.writeNodeModelId(input.nodeId, requestModelKey)
  }

  const saved = await input.saveCurrentSnapshot()
  if (!saved) {
    throw new Error('保存画布节点模型失败，请稍后重试')
  }
}

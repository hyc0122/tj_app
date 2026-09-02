import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Node } from '@xyflow/react'

const serverMocks = vi.hoisted(() => ({
  runTaskByVendor: vi.fn(),
  fetchPublicTaskResultWithAuth: vi.fn(),
}))

vi.mock('../../../api/server', async () => ({
  ...await vi.importActual<typeof import('../../../api/server')>('../../../api/server'),
  runTaskByVendor: serverMocks.runTaskByVendor,
  fetchPublicTaskResultWithAuth: serverMocks.fetchPublicTaskResultWithAuth,
}))

import { useRFStore } from '../../store'
import { collectRecomposableLayerAssets, runImageLayerSplit } from './imageLayerActions'

describe('collectRecomposableLayerAssets', () => {
  it('keeps only real assets from the requested operation and orders them by layer index', () => {
    const nodes: Node[] = [
      { id: 'second', position: { x: 0, y: 0 }, data: { isImageLayer: true, layerOperationNodeId: 'op', layerIndex: 2, imageUrl: 'https://assets/second.png', serverAssetId: 'asset-2' } },
      { id: 'other', position: { x: 0, y: 0 }, data: { isImageLayer: true, layerOperationNodeId: 'other-op', layerIndex: 0, imageUrl: 'https://assets/other.png' } },
      { id: 'empty', position: { x: 0, y: 0 }, data: { isImageLayer: true, layerOperationNodeId: 'op', layerIndex: 0, imageUrl: '' } },
      { id: 'first', position: { x: 0, y: 0 }, data: { isImageLayer: true, layerOperationNodeId: 'op', layerIndex: 1, imageUrl: 'https://assets/first.png' } },
    ]

    expect(collectRecomposableLayerAssets(nodes, 'op')).toEqual([
      { nodeId: 'first', url: 'https://assets/first.png', assetId: null },
      { nodeId: 'second', url: 'https://assets/second.png', assetId: 'asset-2' },
    ])
  })
})

describe('runImageLayerSplit model routing', () => {
  beforeEach(() => {
    serverMocks.runTaskByVendor.mockReset()
    serverMocks.fetchPublicTaskResultWithAuth.mockReset()
    useRFStore.getState().reset()
    useRFStore.setState({
      nodes: [{
        id: 'source-image',
        type: 'taskNode',
        position: { x: 20, y: 40 },
        data: { kind: 'image', imageOperationRevision: 0 },
      }],
      edges: [],
    })
  })

  it('能力目录没有 layer_decompose 模型时不创建节点也不发送任务', async () => {
    await runImageLayerSplit({
      data: {},
      nodeId: 'source-image',
      nodeWidth: 320,
      primaryImageUrl: 'https://assets.example/source.png',
      resolveImageLayerModel: () => null,
      sleep: vi.fn(),
    })

    expect(serverMocks.runTaskByVendor).not.toHaveBeenCalled()
    expect(useRFStore.getState().nodes.map((node) => node.id)).toEqual(['source-image'])
  })

  it('最终请求严格发送目录返回的 requestModelKey，不把展示值当路由键', async () => {
    serverMocks.runTaskByVendor.mockResolvedValue({
      id: 'layer-task-1',
      kind: 'image_edit',
      status: 'succeeded',
      assets: [{
        type: 'image',
        url: 'https://assets.example/layer-1.png',
        assetId: 'asset-layer-1',
      }],
      raw: {},
    })

    await runImageLayerSplit({
      data: {},
      nodeId: 'source-image',
      nodeWidth: 320,
      primaryImageUrl: 'https://assets.example/source.png',
      resolveImageLayerModel: () => ({
        value: '图层分离（生产别名）',
        requestModelKey: 'provider-a/layer-decompose-v3',
      }),
      sleep: vi.fn(),
    })

    expect(serverMocks.runTaskByVendor).toHaveBeenCalledTimes(1)
    expect(serverMocks.runTaskByVendor).toHaveBeenCalledWith(
      'auto',
      expect.objectContaining({
        kind: 'image_edit',
        extras: expect.objectContaining({
          modelKey: 'provider-a/layer-decompose-v3',
          imageOperation: 'layer_decompose',
          referenceImages: ['https://assets.example/source.png'],
        }),
      }),
    )

    const operationNode = useRFStore.getState().nodes.find((node) => {
      const data = node.data as Record<string, unknown>
      return data.libTvImageOperationKey === 'layer-decompose'
    })
    expect(operationNode?.data).toMatchObject({
      imageModel: '图层分离（生产别名）',
      imageLayerDecomposition: {
        modelKey: 'provider-a/layer-decompose-v3',
        modelValue: '图层分离（生产别名）',
      },
    })
  })
})

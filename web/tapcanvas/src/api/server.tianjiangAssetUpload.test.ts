import { afterEach, describe, expect, it, vi } from 'vitest'

import { uploadServerAssetFile } from './server'

function uploadedAssetResponse(): Response {
  return new Response(JSON.stringify({
    id: '7f297071-1722-405b-8f76-53b90d64e98e',
    name: 'scene.png',
    data: {
      url: '/api/tianjiang/runtime/projects/project/files/images/asset.png',
      kind: 'upload',
      lifecycleState: 'ready',
    },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    userId: '1',
    projectId: '4dc24872-e40e-42c7-b421-c03055754b7a',
  }), { status: 201, headers: { 'Content-Type': 'application/json' } })
}

describe('天将 TapCanvas 素材上传', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('始终把原始文件流发给项目上传接口，不请求预签名地址', async () => {
    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>()
      .mockResolvedValueOnce(uploadedAssetResponse())
    vi.stubGlobal('fetch', fetchMock)
    const file = new File([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ], 'scene.png', { type: 'image/png' })

    const result = await uploadServerAssetFile(file, '场景图.png', {
      projectId: '4dc24872-e40e-42c7-b421-c03055754b7a',
      ownerNodeId: 'e29e242c-1bdc-4b11-acf0-62f0b64e95be',
    })

    expect(result.data.url).toContain('/api/tianjiang/runtime/projects/')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [requestUrl, request] = fetchMock.mock.calls[0]!
    expect(String(requestUrl)).toContain('/api/tianjiang/tapcanvas/assets/upload?')
    expect(String(requestUrl)).toContain('projectId=4dc24872-e40e-42c7-b421-c03055754b7a')
    expect(request?.body).toBe(file)
    expect(request?.headers).toMatchObject({
      'Content-Type': 'image/png',
      'X-File-Size': String(file.size),
    })
  })
})

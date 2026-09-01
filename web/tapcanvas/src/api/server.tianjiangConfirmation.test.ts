import { afterEach, describe, expect, it, vi } from 'vitest'

const confirmMock = vi.hoisted(() => vi.fn())

vi.mock('../tianjiang/confirmGate', () => ({
  requestTianjiangPaidConfirm: confirmMock,
}))

import { runPublicTask, runPublicTaskWithAuth } from './server'

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('天将收费任务确认合同', () => {
  afterEach(() => {
    confirmMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('确认后必须原样回传权威确认单，且只弹出一次确认框', async () => {
    confirmMock.mockResolvedValue(true)
    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({
        code: 'confirmation_required',
        confirmationUuid: '38c69d4a-84fa-42b2-bdb0-b1534185512d',
        requestDigest: 'a'.repeat(64),
        baseRevision: 7,
        fee: { displayText: '实际费用以模型服务商结算为准' },
      }, 409))
      .mockResolvedValueOnce(jsonResponse({
        vendor: 'tianjiang',
        result: {
          id: 'canvas:project:run',
          kind: 'text_to_image',
          status: 'queued',
          assets: [],
          raw: { state: 'waiting_for_origin_device' },
        },
      }, 202))
    vi.stubGlobal('fetch', fetchMock)

    const response = await runPublicTaskWithAuth({
      request: {
        kind: 'text_to_image',
        prompt: '生成一张夜景海报',
        extras: {
          modelKey: 'jiasu:flux-pro',
          generationContext: {
            projectId: '28a7ee5d-1951-46f9-a463-80876de259e9',
            nodeId: 'c95cf1a7-39a4-4f1b-ae8e-4c98ef278876',
          },
        },
      },
    })

    expect(response.result.status).toBe('queued')
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondRequest = fetchMock.mock.calls[1]?.[1]
    const secondBody = JSON.parse(String(secondRequest?.body)) as Record<string, unknown>
    expect(secondBody.confirmationUuid).toBe('38c69d4a-84fa-42b2-bdb0-b1534185512d')
    expect(secondBody.requestDigest).toBe('a'.repeat(64))
    expect(secondBody.baseRevision).toBe(7)
    expect(secondBody.clientRequestId).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('用户取消时不得发出第二次执行请求', async () => {
    confirmMock.mockResolvedValue(false)
    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({
        code: 'confirmation_required',
        confirmationUuid: '38c69d4a-84fa-42b2-bdb0-b1534185512d',
        requestDigest: 'b'.repeat(64),
        baseRevision: 3,
        fee: { displayText: '可能产生费用' },
      }, 409))
    vi.stubGlobal('fetch', fetchMock)

    await expect(runPublicTaskWithAuth({
      request: {
        kind: 'text_to_video',
        prompt: '生成五秒镜头',
        extras: {
          modelKey: 'jiasu:seedance',
          generationContext: {
            projectId: '28a7ee5d-1951-46f9-a463-80876de259e9',
            nodeId: 'c95cf1a7-39a4-4f1b-ae8e-4c98ef278876',
          },
        },
      },
    })).rejects.toThrow('已取消确认执行')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('画布运行器使用会话 Cookie 时也必须进入同一权威确认链', async () => {
    confirmMock.mockResolvedValue(true)
    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({
        code: 'confirmation_required',
        confirmationUuid: '9d78719a-9055-4dbb-ae2a-fbc33d46fdd5',
        requestDigest: 'c'.repeat(64),
        baseRevision: 9,
        fee: { displayText: '可能产生费用' },
      }, 409))
      .mockResolvedValueOnce(jsonResponse({
        vendor: 'jiasu',
        result: { id: 'tc1:project:run', kind: 'text_to_image', status: 'queued', assets: [] },
      }, 202))
    vi.stubGlobal('fetch', fetchMock)

    await runPublicTask('', {
      request: {
        kind: 'text_to_image',
        prompt: '测试画布节点',
        extras: {
          modelKey: 'jiasu:seedream-4',
          generationContext: {
            projectId: '28a7ee5d-1951-46f9-a463-80876de259e9',
            nodeId: 'c95cf1a7-39a4-4f1b-ae8e-4c98ef278876',
          },
        },
      },
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>
    expect(secondBody.confirmationUuid).toBe('9d78719a-9055-4dbb-ae2a-fbc33d46fdd5')
    expect(secondBody.requestDigest).toBe('c'.repeat(64))
    expect(secondBody.baseRevision).toBe(9)
  })
})

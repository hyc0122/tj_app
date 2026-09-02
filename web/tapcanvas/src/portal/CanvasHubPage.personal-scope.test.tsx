// @vitest-environment jsdom
import React from 'react'
import { MantineProvider } from '@mantine/core'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultProjectDirectoryState } from '@tapcanvas/project-directory-protocol'
import { installMantineDomMocks } from './testMantineDomMocks'

installMantineDomMocks()

const {
  listPublicProjects,
  bootstrapProjectFlow,
  cloneProject,
} = vi.hoisted(() => ({
  listPublicProjects: vi.fn(),
  bootstrapProjectFlow: vi.fn(),
  cloneProject: vi.fn(),
}))

vi.mock('../api/server', () => ({
  listPublicProjects,
  bootstrapProjectFlow,
  cloneProject,
}))

vi.mock('../auth/store', () => ({
  useAuth: () => ({ token: 'auth-token', user: { login: 'owner' } }),
}))

vi.mock('../auth/LoginModal', () => ({
  LoginModal: () => null,
}))

vi.mock('./PortalHeader', () => ({
  PortalHeader: () => <header>TapCanvas</header>,
}))

vi.mock('./PortalFooter', () => ({
  PortalFooter: () => <footer>footer</footer>,
}))

vi.mock('./homepagePreviewSnapshot', () => ({
  useHomepagePreviewSnapshot: () => null,
}))

vi.mock('./useProjectLibrary', () => ({
  useProjectLibrary: () => ({
    projects: [],
    projectCovers: {},
    loading: false,
    error: '',
    createProject: vi.fn(),
    registerProject: vi.fn(),
    unregisterProject: vi.fn(),
    reload: vi.fn(),
  }),
}))

vi.mock('./useProjectDirectory', () => ({
  useProjectDirectory: () => ({
    state: createDefaultProjectDirectoryState(1),
    loading: false,
    saving: false,
    conflicted: false,
    error: '',
    retry: vi.fn(),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    moveNode: vi.fn(),
    canMoveNode: () => false,
    placeProject: vi.fn(),
    renameProject: vi.fn(),
    removeProject: vi.fn(),
  }),
}))

vi.mock('./useProjectManagementActions', () => ({
  useProjectManagementActions: () => ({
    managingProjectId: null,
    sharingProjectId: null,
    shareAvailable: false,
    pendingCleanup: null,
    renameTarget: null,
    renameDraft: '',
    setRenameDraft: vi.fn(),
    closeRename: vi.fn(),
    submitRename: vi.fn(),
    renameProject: vi.fn(),
    deleteProject: vi.fn(),
    toggleShare: vi.fn(),
    retryPendingCleanup: vi.fn(),
  }),
}))

vi.mock('../domain/resource-runtime/components/ManagedImage', () => ({
  ManagedImage: ({ alt }: { alt: string }) => <img alt={alt} />,
}))

vi.mock('./ProjectRenameModal', () => ({
  ProjectRenameModal: () => null,
}))

vi.mock('../utils/spaNavigate', () => ({
  spaNavigate: vi.fn(),
}))

import CanvasHubPage from './CanvasHubPage'

function renderPage(): ReturnType<typeof render> {
  return render(
    <MantineProvider>
      <CanvasHubPage />
    </MantineProvider>,
  )
}

describe('CanvasHubPage personal templates', () => {
  beforeEach(() => {
    listPublicProjects.mockReset()
    bootstrapProjectFlow.mockReset()
    cloneProject.mockReset()
  })

  afterEach(() => cleanup())

  it('未调用远端公开项目接口时仍展示六个内置热门模板', async () => {
    listPublicProjects.mockImplementation(() => new Promise(() => undefined))
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('上传小说')).toBeTruthy()
    })
    expect(screen.getByText('故事板成片')).toBeTruthy()
    expect(screen.getByText('一句话出图')).toBeTruthy()
    expect(screen.getByText('首帧转视频')).toBeTruthy()
    expect(screen.getByText('导演台')).toBeTruthy()
    expect(screen.getByText('AI 执行台')).toBeTruthy()
    expect(screen.queryByText('当前暂无已配置的公开模板')).toBeNull()
  })

  it('远端公开项目 500 时六个内置模板仍可用，且没有阻断性红色错误', async () => {
    listPublicProjects.mockRejectedValue(new Error('list public projects failed: 500'))
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('上传小说')).toBeTruthy()
    })
    expect(screen.getByText('导演台')).toBeTruthy()
    expect(screen.getByText('AI 执行台')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/公开模板加载失败/)).toBeNull()
  })

  it('使用内置模板时创建个人画布并写入重新生成 ID 的节点图', async () => {
    listPublicProjects.mockResolvedValue([])
    bootstrapProjectFlow.mockResolvedValue({
      status: 'complete',
      project: {
        id: '11111111-1111-4111-8111-111111111111',
        name: '上传小说',
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
        access: 'owner',
        teamShared: false,
      },
      flow: { id: '11111111-1111-4111-8111-111111111111', canvasRevision: 1 },
    })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /上传小说/ }))
    await waitFor(() => {
      expect(bootstrapProjectFlow).toHaveBeenCalledTimes(1)
    })
    const payload = bootstrapProjectFlow.mock.calls[0]?.[0] as {
      name: string
      nodes: Array<{ id: string }>
      edges: Array<{ id: string; source: string; target: string }>
    }
    expect(payload.name).toBe('上传小说')
    expect(payload.nodes.some((node) => node.id.startsWith('tpl-'))).toBe(false)
    expect(payload.edges.some((edge) => edge.id.startsWith('tpl-'))).toBe(false)
    expect(cloneProject).not.toHaveBeenCalled()
  })
})

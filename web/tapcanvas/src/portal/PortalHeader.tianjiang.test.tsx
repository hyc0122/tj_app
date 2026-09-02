// @vitest-environment jsdom

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PortalHeader } from './PortalHeader'

vi.mock('../auth/store', () => ({
  useAuth: () => ({ token: null }),
}))

vi.mock('../auth/isAdmin', () => ({
  useIsAdmin: () => false,
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('天将无限画布中心顶栏', () => {
  it('隐藏重复品牌和门户导航，但保留账号入口', () => {
    render(<PortalHeader active="projects" />)

    expect(screen.queryByLabelText('TapCanvas 首页')).toBeNull()
    expect(screen.queryByRole('navigation', { name: '主导航' })).toBeNull()
    expect(screen.getByRole('button', { name: '登录' })).not.toBeNull()
  })
})

// @vitest-environment jsdom

import React from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
    expect(screen.getByRole('banner').classList.contains('neo-portal-header--account-only')).toBe(true)
  })

  it('账号入口采用右上角浮层布局，不再占用画布中心的一整行', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/portal/CanvasHubPage.css'), 'utf8')
    const rule = css.match(/\.canvas-hub-page\s*>\s*\.neo-portal-header--account-only\s*\{([^}]+)\}/)?.[1] || ''

    expect(rule).toContain('position: absolute')
    expect(rule).toContain('left: auto')
    expect(rule).toContain('width: auto')
    expect(rule).toContain('height: auto')
  })
})

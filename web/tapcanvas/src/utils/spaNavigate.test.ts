// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { navigateBackOr, spaNavigate, spaReplace } from './spaNavigate'

describe('spa navigation history', () => {
  const originalParent = window.parent

  beforeEach(() => {
    window.sessionStorage.clear()
    window.history.replaceState({}, '', '/chapter/current')
    Object.defineProperty(window, 'parent', { configurable: true, value: originalParent })
  })

  it('returns to the fallback route when the current page has no app route history', () => {
    const back = vi.spyOn(window.history, 'back')

    navigateBackOr('/')

    expect(back).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe('/')
  })

  it('uses browser back after an in-app route was pushed', () => {
    spaNavigate('/chapter/next')
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined)

    navigateBackOr('/')

    expect(back).toHaveBeenCalledOnce()
    expect(window.location.pathname).toBe('/chapter/next')
  })

  it('does not create a back entry when replacing an app route', () => {
    spaReplace('/chapter/replaced')
    const back = vi.spyOn(window.history, 'back')

    navigateBackOr('/')

    expect(back).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe('/')
  })

  it('天将宿主模式下把画布项目导航交给父窗口，避免 iframe 绕过项目打开与关闭生命周期', () => {
    const postMessage = vi.fn()
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: { postMessage },
    })
    window.history.replaceState({}, '', '/tapcanvas/index.html?tjHost=1')

    spaNavigate('/studio?projectId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19')

    expect(postMessage).toHaveBeenCalledWith({
      type: 'tianjiang:tapcanvas:navigate',
      destination: 'studio',
      projectUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19',
      replace: false,
    }, window.location.origin)
    expect(window.location.pathname).toBe('/tapcanvas/index.html')
  })
})

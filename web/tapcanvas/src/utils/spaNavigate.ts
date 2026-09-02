import { useIntentLifecycle } from '../canvas/intentLifecycle'

const NAVIGATION_STATE_KEY = '__tapcanvasNavigation'
const NAVIGATION_SESSION_KEY = 'tapcanvas:navigation-session'
const TIANJIANG_HOST_SESSION_KEY = 'tapcanvas:tianjiang-host'

interface TapCanvasNavigationState {
  sessionId: string
  index: number
}

type BrowserHistoryState = Record<string, unknown>

function readHistoryState(): BrowserHistoryState {
  const state: unknown = window.history.state
  return state !== null && typeof state === 'object' && !Array.isArray(state)
    ? state as BrowserHistoryState
    : {}
}

function getNavigationSessionId(): string {
  const stored = window.sessionStorage.getItem(NAVIGATION_SESSION_KEY)
  if (stored) return stored
  const created = crypto.randomUUID()
  window.sessionStorage.setItem(NAVIGATION_SESSION_KEY, created)
  return created
}

function readNavigationState(): TapCanvasNavigationState | null {
  const value = readHistoryState()[NAVIGATION_STATE_KEY]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const sessionId = Reflect.get(value, 'sessionId')
  const index = Reflect.get(value, 'index')
  if (typeof sessionId !== 'string' || typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null
  if (sessionId !== getNavigationSessionId()) return null
  return { sessionId, index }
}

function ensureNavigationState(): TapCanvasNavigationState {
  const current = readNavigationState()
  if (current) return current
  const initial = { sessionId: getNavigationSessionId(), index: 0 }
  window.history.replaceState({ ...readHistoryState(), [NAVIGATION_STATE_KEY]: initial }, '', window.location.href)
  return initial
}

function historyStateAt(index: number): BrowserHistoryState {
  return {
    ...readHistoryState(),
    [NAVIGATION_STATE_KEY]: { sessionId: getNavigationSessionId(), index },
  }
}

/**
 * 同 path 的"导航"不算切换路由（只是 hash/query 变化），不触发 agent 守卫。
 * 跨 path 的程序导航前都要先问一下是否要终止 agent。
 */
function shouldGuard(to: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    const targetPath = new URL(to, window.location.origin).pathname
    return targetPath !== window.location.pathname
  } catch {
    return true
  }
}

/**
 * 天将桌面端把 TapCanvas 放在同源 iframe 内。画布项目切换必须交给宿主路由，
 * 由宿主持有并准确关闭项目运行时代次，禁止 iframe 私自切页造成项目句柄常驻。
 */
function navigateThroughTianjiangHost(to: string, replace: boolean): boolean {
  if (typeof window === 'undefined' || window.parent === window) return false
  const current = new URL(window.location.href)
  if (current.searchParams.get('tjHost') === '1') {
    window.sessionStorage.setItem(TIANJIANG_HOST_SESSION_KEY, '1')
  }
  if (window.sessionStorage.getItem(TIANJIANG_HOST_SESSION_KEY) !== '1') return false
  const target = new URL(to, window.location.origin)
  if (target.origin !== window.location.origin) return false
  const normalizedPath = target.pathname.replace(/^\/tapcanvas(?=\/|$)/, '') || '/'
  const projectUuid = target.searchParams.get('projectId')?.trim() ?? ''
  if ((normalizedPath === '/studio' || normalizedPath.startsWith('/studio/')) && projectUuid) {
    const currentProjectUuid = current.searchParams.get('projectId')?.trim() ?? ''
    if (currentProjectUuid === projectUuid) {
      // 中文注释：裸项目入口会在 iframe 内规范化为带 owner 的 Studio 地址。
      // 同项目不能再交给宿主，否则宿主路由未变、iframe 也未 replace，画布会永久停在加载页。
      return false
    }
    window.parent.postMessage({
      type: 'tianjiang:tapcanvas:navigate',
      destination: 'studio',
      projectUuid,
      replace,
    }, window.location.origin)
    return true
  }
  if (normalizedPath === '/' || normalizedPath === '/projects' || normalizedPath === '/canvas') {
    window.parent.postMessage({
      type: 'tianjiang:tapcanvas:navigate',
      destination: 'home',
      projectUuid: null,
      replace,
    }, window.location.origin)
    return true
  }
  return false
}

export function spaNavigate(to: string) {
  if (typeof window === 'undefined') return
  if (shouldGuard(to) && !useIntentLifecycle.getState().confirmAbandonAgent()) return
  const next = String(to || '').trim() || '/'
  if (navigateThroughTianjiangHost(next, false)) return
  try {
    const current = ensureNavigationState()
    window.history.pushState(historyStateAt(current.index + 1), '', next)
    // Ensure React re-renders listeners that rely on location.
    window.dispatchEvent(new PopStateEvent('popstate'))
  } catch {
    window.location.href = next
  }
}

export function spaReplace(to: string) {
  if (typeof window === 'undefined') return
  if (shouldGuard(to) && !useIntentLifecycle.getState().confirmAbandonAgent()) return
  const next = String(to || '').trim() || '/'
  if (navigateThroughTianjiangHost(next, true)) return
  try {
    const current = ensureNavigationState()
    window.history.replaceState(historyStateAt(current.index), '', next)
    window.dispatchEvent(new PopStateEvent('popstate'))
  } catch {
    window.location.replace(next)
  }
}

export function navigateBackOr(to: string) {
  if (typeof window === 'undefined') return
  // history.back() 走浏览器原生导航，会触发 popstate；那里的全局守卫会拦截，
  // 这里不再单独问，避免重复弹窗。
  const current = ensureNavigationState()
  if (current.index > 0) {
    window.history.back()
    return
  }
  spaNavigate(to)
}

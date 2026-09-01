import React from 'react'
import { PortalRouter, resolvePortalPageRoute } from './portal/PortalRouter'
import { CanvasLoadingScreen } from './ui/CanvasLoadingScreen'
import { installPageMediaLifecycle } from './utils/mediaPlayback'
import { resolveCodexPreviewId } from './utils/appRoutes'
import { TAPCANVAS_HIDE_COMMUNITY, TAPCANVAS_HIDE_TEAM, stripTapcanvasBase } from './tianjiang/integrationFlags'

const PortalRuntimeLazy = React.lazy(() => import('./runtime/PortalRuntime'))
const WorkspaceRuntimeLazy = React.lazy(() => import('./runtime/WorkspaceRuntime'))
const CodexPreviewPageLazy = React.lazy(() => import('./preview/CodexPreviewPage'))

export default function RouteEntrypoint(): JSX.Element {
  const [, refreshRoute] = React.useReducer((value: number) => value + 1, 0)

  React.useEffect(() => {
    const handleRouteChange = () => refreshRoute()
    return installPageMediaLifecycle(handleRouteChange)
  }, [])

  const pathname = typeof window === 'undefined' ? '/' : stripTapcanvasBase(window.location.pathname)
  const previewId = resolveCodexPreviewId(pathname)
  if (previewId) {
    return (
      <React.Suspense fallback={<CanvasLoadingScreen fixed />}>
        <CodexPreviewPageLazy previewId={previewId} />
      </React.Suspense>
    )
  }
  const portalRoute = resolvePortalPageRoute(pathname)
  if (TAPCANVAS_HIDE_COMMUNITY && portalRoute && portalRoute !== 'canvas-hub') {
    return <PortalRouter route="canvas-hub" />
  }
  if (portalRoute === 'home') {
    return TAPCANVAS_HIDE_COMMUNITY
      ? <PortalRouter route="canvas-hub" />
      : <PortalRouter route={portalRoute} />
  }
  if (portalRoute) {
    return (
      <React.Suspense fallback={<CanvasLoadingScreen fixed />}>
        <PortalRuntimeLazy route={portalRoute} />
      </React.Suspense>
    )
  }
  void TAPCANVAS_HIDE_TEAM

  return (
    <React.Suspense fallback={<CanvasLoadingScreen fixed />}>
      <WorkspaceRuntimeLazy />
    </React.Suspense>
  )
}

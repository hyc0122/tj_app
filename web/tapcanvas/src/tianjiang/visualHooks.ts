/** 中文注释：仅供本机 Electron 视觉验收调用，不改变生产交互。 */
import { requestTianjiangPaidConfirm } from './confirmGate'

function isVisualAcceptanceEnabled(): boolean {
  if (typeof window === 'undefined') return false

  // 中文注释：视觉验收钩子只能由本机测试页面显式开启，生产页面不会暴露该入口。
  const hostname = window.location.hostname.toLowerCase()
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') return false

  return new URLSearchParams(window.location.search).get('tianjiangVisualAcceptance') === '1'
}

export function installTianjiangVisualHooks(): void {
  if (!isVisualAcceptanceEnabled()) return
  Object.defineProperty(window, '__tjVisual', {
    configurable: true,
    value: {
      openConfirm: () => requestTianjiangPaidConfirm({
        fee: { displayText: '可能产生费用，请确认后执行' },
        message: '收费任务必须先预览并确认',
      }),
      openChat: () => {
        const visualWindow = window as Window & { __tcExpandChat?: () => void }
        if (!visualWindow.__tcExpandChat) {
          throw new Error('真实 AI 对话组件尚未挂载')
        }
        // 中文注释：必须调用产品组件自身的展开动作，不能只篡改一个旁路状态值。
        visualWindow.__tcExpandChat()
      },
    },
  })
}

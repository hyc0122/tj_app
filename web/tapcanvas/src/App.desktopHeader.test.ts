import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('天将桌面端画布页头', () => {
  it('只保留软件模型路由需要的入口，不再展示或请求 TapCanvas 积分余额', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'App.tsx'), 'utf8')

    expect(source).not.toContain('app-credit-balance')
    expect(source).not.toContain('IconCoins')
    expect(source).not.toContain('getMyTeam')
    expect(source).not.toContain('headerPointsLoading')
    expect(source).not.toContain('tapcanvas:team-changed')
    expect(source).toContain('AI 执行台')
    expect(source).toContain('applyCompletedCanvasSave({')
  })
})

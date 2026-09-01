import { describe, expect, it } from 'vitest'
import { tapcanvasAssetUrl } from './tapcanvasAssetUrl'

describe('TapCanvas 静态资源 base path', () => {
  it('生产 BASE_URL 下导演台模型不得落到站点根 /director', () => {
    expect(import.meta.env.BASE_URL).toMatch(/\/tapcanvas\/?$/)
    expect(tapcanvasAssetUrl('/director/xbot.glb')).toBe('/tapcanvas/director/xbot.glb')
    expect(tapcanvasAssetUrl('director/xbot.glb')).toBe('/tapcanvas/director/xbot.glb')
    expect(tapcanvasAssetUrl('/director/xbot.glb')).not.toBe('/director/xbot.glb')
  })

  it('blob/http 外部地址保持原样', () => {
    expect(tapcanvasAssetUrl('blob:http://localhost/abc')).toBe('blob:http://localhost/abc')
    expect(tapcanvasAssetUrl('https://cdn.example/a.glb')).toBe('https://cdn.example/a.glb')
  })
})

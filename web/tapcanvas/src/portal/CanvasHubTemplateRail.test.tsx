// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasHubTemplateRail, type ConfiguredCanvasTemplate } from './CanvasHubTemplateRail'

vi.mock('../domain/resource-runtime/components/ManagedImage', () => ({
  ManagedImage: ({ alt, src }: { alt: string; src: string }) => (
    <img alt={alt} src={src} />
  ),
}))

afterEach(() => cleanup())

function template(id: string, title: string): ConfiguredCanvasTemplate {
  return {
    id,
    name: title,
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    access: 'owner',
    teamShared: false,
    templateTitle: title,
    templateCoverUrl: `/covers/${id}.jpg`,
  }
}

const SIX: ConfiguredCanvasTemplate[] = [
  template('builtin-canvas:upload-novel', '上传小说'),
  template('builtin-canvas:storyboard-film', '故事板成片'),
  template('builtin-canvas:sentence-image', '一句话出图'),
  template('builtin-canvas:first-frame-video', '首帧转视频'),
  template('builtin-canvas:director-console', '导演台'),
  template('builtin-canvas:ai-execution', 'AI 执行台'),
]

describe('CanvasHubTemplateRail', () => {
  it('远端公开项目 404 时仍展示六个内置模板，且不得用阻断性红色错误盖住热门区', () => {
    render(
      <CanvasHubTemplateRail
        templates={SIX}
        loading={false}
        error="list public projects failed: 404"
        cloningTemplateId={null}
        onUseTemplate={() => undefined}
      />,
    )
    expect(screen.getByText('上传小说')).toBeTruthy()
    expect(screen.getByText('故事板成片')).toBeTruthy()
    expect(screen.getByText('一句话出图')).toBeTruthy()
    expect(screen.getByText('首帧转视频')).toBeTruthy()
    expect(screen.getByText('导演台')).toBeTruthy()
    expect(screen.getByText('AI 执行台')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('当前暂无已配置的公开模板')).toBeNull()
  })
})

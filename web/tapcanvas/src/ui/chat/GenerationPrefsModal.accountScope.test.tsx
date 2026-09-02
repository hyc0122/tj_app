// @vitest-environment jsdom

import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../../auth/store'
import type { ModelOption } from '../../config/models'

const mocks = vi.hoisted(() => ({
  loadGenerationPrefs: vi.fn(),
  saveGenerationPrefs: vi.fn(),
  imageOptions: [
  { value: 'image-a', label: '图片 A', modelKey: 'provider:image-a' },
  { value: 'image-b', label: '图片 B', modelKey: 'provider:image-b' },
  ] as ModelOption[],
  videoOptions: [
  {
    value: 'video-a',
    label: '视频 A',
    modelKey: 'provider:video-a',
    meta: {
      videoOptions: {
        defaultResolution: '768p',
        resolutionOptions: [{ value: '768p', label: '768P' }],
        defaultSize: '16:9',
        sizeOptions: [{ value: '16:9', label: '16:9', aspectRatio: '16:9' }],
      },
    },
  },
  {
    value: 'video-b',
    label: '视频 B',
    modelKey: 'provider:video-b',
    meta: {
      videoOptions: {
        defaultResolution: '1080p',
        resolutionOptions: [{ value: '1080p', label: '1080P' }],
        defaultSize: '9:16',
        sizeOptions: [{ value: '9:16', label: '9:16', aspectRatio: '9:16' }],
      },
    },
  },
  ] as ModelOption[],
}))

vi.mock('../../config/generationPrefs', () => ({
  loadGenerationPrefs: mocks.loadGenerationPrefs,
  saveGenerationPrefs: mocks.saveGenerationPrefs,
}))

vi.mock('../../config/useModelOptions', () => ({
  useModelOptionsState: (kind: string) => ({
    options: kind === 'video' ? mocks.videoOptions : mocks.imageOptions,
    loading: false,
    error: null,
    retry: vi.fn(),
  }),
  findModelOptionByIdentifier: (options: ModelOption[], identifier: string) =>
    options.find((option) => [option.value, option.modelKey, option.modelAlias].includes(identifier)) ?? null,
  getModelOptionRequestAlias: (options: ModelOption[], identifier: string) =>
    options.find((option) => [option.value, option.modelKey, option.modelAlias].includes(identifier))?.modelKey ?? identifier,
}))

// 中文注释：把 Mantine 控件压缩为可直接交互的原生控件，专注验证账号切换生命周期。
vi.mock('@mantine/core', () => ({
  Modal: ({ opened, children }: { opened: boolean; children: React.ReactNode }) => opened ? <div>{children}</div> : null,
  Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" onClick={onClick} disabled={disabled}>{children}</button>
  ),
  Select: ({ label, value, onChange, data = [], disabled }: {
    label: string
    value?: string | null
    onChange?: (value: string | null) => void
    data?: Array<{ value: string; label: string }>
    disabled?: boolean
  }) => (
    <label>
      {label}
      <select
        aria-label={label}
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange?.(event.currentTarget.value || null)}
      >
        <option value="" />
        {data.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  ),
}))

import { GenerationPrefsModal } from './GenerationPrefsModal'

describe('GenerationPrefsModal account scope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAuth.setState({
      token: 'cookie-session',
      user: { sub: 'account-a', login: 'account-a' },
      loading: false,
    })
    mocks.loadGenerationPrefs.mockImplementation(async () => {
      const accountId = String(useAuth.getState().user?.sub ?? '')
      return accountId === 'account-a'
        ? {
            imageModel: 'provider:image-a',
            imageSize: '1K',
            videoModel: 'provider:video-a',
            videoResolution: '768p',
            videoAspect: '16:9',
          }
        : {
            imageModel: 'provider:image-b',
            imageSize: '2K',
            videoModel: 'provider:video-b',
            videoResolution: '1080p',
            videoAspect: '9:16',
          }
    })
    mocks.saveGenerationPrefs.mockImplementation(async (prefs) => prefs)
  })

  it('弹窗保持打开切换账号时重新加载，并且只保存新账号表单', async () => {
    render(<GenerationPrefsModal opened onClose={vi.fn()} />)

    await waitFor(() => expect((screen.getByLabelText('生图模型') as HTMLSelectElement).value).toBe('image-a'))
    expect(mocks.loadGenerationPrefs).toHaveBeenCalledTimes(1)

    await act(async () => {
      useAuth.setState({ user: { sub: 'account-b', login: 'account-b' } })
    })

    await waitFor(() => expect((screen.getByLabelText('生图模型') as HTMLSelectElement).value).toBe('image-b'))
    expect(mocks.loadGenerationPrefs).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mocks.saveGenerationPrefs).toHaveBeenCalledWith({
      imageModel: 'provider:image-b',
      imageSize: '2K',
      videoModel: 'provider:video-b',
      videoResolution: '1080p',
      videoAspect: '9:16',
    }))
  })
})

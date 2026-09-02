import { describe, expect, it, vi } from 'vitest'
import type { UserGenerationPrefsDto } from '../api/server'
import type { ModelOption } from './models'
import { DEFAULT_GENERATION_PREFS } from './generationPrefs'
import * as generationPrefs from './generationPrefs'

describe('DEFAULT_GENERATION_PREFS', () => {
  it('does not invent image or video models before the live model-service catalog arrives', () => {
    expect(DEFAULT_GENERATION_PREFS.imageModel).toBe('')
    expect(DEFAULT_GENERATION_PREFS.videoModel).toBe('')
  })

  it('persists the model-service request key instead of its display alias', () => {
    type ToGenerationPreferenceModelPatch = (
      field: 'imageModel' | 'videoModel',
      option: ModelOption,
    ) => { imageModel?: string; videoModel?: string }
    const toGenerationPreferenceModelPatch = (
      generationPrefs as typeof generationPrefs & {
        toGenerationPreferenceModelPatch?: ToGenerationPreferenceModelPatch
      }
    ).toGenerationPreferenceModelPatch
    expect(toGenerationPreferenceModelPatch).toBeTypeOf('function')
    if (!toGenerationPreferenceModelPatch) return

    expect(toGenerationPreferenceModelPatch('imageModel', {
      value: 'gpt-image-real',
      label: '模型服务里的真实图片模型',
      modelKey: 'atlas:gpt-image-real',
      modelAlias: 'gpt-image-real',
    })).toEqual({ imageModel: 'atlas:gpt-image-real' })
  })
})

type GenerationPrefsRuntime = {
  getCached: () => UserGenerationPrefsDto | null
  load: (force?: boolean) => Promise<UserGenerationPrefsDto | null>
  save: (prefs: UserGenerationPrefsDto) => Promise<UserGenerationPrefsDto | null>
  updateRecent: (patch: UserGenerationPrefsDto) => Promise<UserGenerationPrefsDto | null>
}

type CreateGenerationPrefsRuntime = (input: {
  read: () => Promise<UserGenerationPrefsDto | null>
  write: (prefs: UserGenerationPrefsDto) => Promise<UserGenerationPrefsDto | null>
  getScopeKey: () => string
  onChanged?: (prefs: UserGenerationPrefsDto | null) => void
}) => GenerationPrefsRuntime

function readRuntimeFactory(): CreateGenerationPrefsRuntime | undefined {
  return (
    generationPrefs as typeof generationPrefs & {
      createGenerationPrefsRuntime?: CreateGenerationPrefsRuntime
    }
  ).createGenerationPrefsRuntime
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('generation preferences runtime', () => {
  it('does not let an older GET overwrite a newer saved preference', async () => {
    const createRuntime = readRuntimeFactory()
    expect(createRuntime).toBeTypeOf('function')
    if (!createRuntime) return

    const pendingRead = deferred<UserGenerationPrefsDto | null>()
    const runtime = createRuntime({
      read: () => pendingRead.promise,
      write: async (prefs) => prefs,
      getScopeKey: () => 'account-a',
    })

    const loadPromise = runtime.load()
    await expect(runtime.save({ imageModel: 'provider:new-model' })).resolves.toEqual({
      imageModel: 'provider:new-model',
    })
    pendingRead.resolve({ imageModel: 'provider:old-model' })

    await expect(loadPromise).resolves.toEqual({ imageModel: 'provider:new-model' })
    expect(runtime.getCached()).toEqual({ imageModel: 'provider:new-model' })
  })

  it('serializes direct saves and recent-selection updates through one queue', async () => {
    const createRuntime = readRuntimeFactory()
    expect(createRuntime).toBeTypeOf('function')
    if (!createRuntime) return

    const firstWrite = deferred<UserGenerationPrefsDto | null>()
    const write = vi.fn()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(async (prefs: UserGenerationPrefsDto) => prefs)
    const runtime = createRuntime({
      read: async () => null,
      write,
      getScopeKey: () => 'account-a',
    })

    const first = runtime.save({ imageModel: 'provider:image-a' })
    const second = runtime.updateRecent({ videoModel: 'provider:video-b' })
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))

    firstWrite.resolve({ imageModel: 'provider:image-a' })
    await first
    await second
    expect(write).toHaveBeenNthCalledWith(2, { videoModel: 'provider:video-b' })
    expect(runtime.getCached()).toEqual({ videoModel: 'provider:video-b' })
  })

  it('drops the previous account cache and ignores its late response after account switch', async () => {
    const createRuntime = readRuntimeFactory()
    expect(createRuntime).toBeTypeOf('function')
    if (!createRuntime) return

    let scope = 'account-a'
    const accountARead = deferred<UserGenerationPrefsDto | null>()
    const runtime = createRuntime({
      read: () => scope === 'account-a'
        ? accountARead.promise
        : Promise.resolve({ imageModel: 'provider:account-b' }),
      write: async (prefs) => prefs,
      getScopeKey: () => scope,
    })

    const accountALoad = runtime.load()
    scope = 'account-b'
    expect(runtime.getCached()).toBeNull()
    await expect(runtime.load()).resolves.toEqual({ imageModel: 'provider:account-b' })

    accountARead.resolve({ imageModel: 'provider:account-a' })
    await expect(accountALoad).resolves.toBeNull()
    expect(runtime.getCached()).toEqual({ imageModel: 'provider:account-b' })
  })

  it('账号切换后丢弃旧账号尚未开始的排队写入，禁止携带新会话写错账号', async () => {
    const createRuntime = readRuntimeFactory()
    expect(createRuntime).toBeTypeOf('function')
    if (!createRuntime) return

    let scope = 'account-a'
    const firstWrite = deferred<UserGenerationPrefsDto | null>()
    const write = vi.fn()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(async (prefs: UserGenerationPrefsDto) => prefs)
    const runtime = createRuntime({
      read: async () => null,
      write,
      getScopeKey: () => scope,
    })

    const first = runtime.save({ imageModel: 'provider:account-a-first' })
    const queued = runtime.save({ imageModel: 'provider:account-a-queued' })
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))

    scope = 'account-b'
    expect(runtime.getCached()).toBeNull()
    firstWrite.resolve({ imageModel: 'provider:account-a-first' })

    await expect(first).resolves.toBeNull()
    await expect(queued).resolves.toBeNull()
    expect(write).toHaveBeenCalledTimes(1)
    expect(runtime.getCached()).toBeNull()
  })
})

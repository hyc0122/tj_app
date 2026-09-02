import { describe, expect, it } from 'vitest'
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

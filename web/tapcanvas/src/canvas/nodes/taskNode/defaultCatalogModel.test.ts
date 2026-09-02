import { describe, expect, it } from 'vitest'
import type { ModelOption } from '../../../config/models'
import {
  resolveCatalogActionModelOption,
  resolveDefaultCatalogModelOption,
} from './defaultCatalogModel'

const options: ModelOption[] = [
  { value: 'catalog-first', label: '目录第一项', vendor: 'first-vendor' },
  { value: 'catalog-second', label: '目录第二项', vendor: 'second-vendor' },
]

describe('resolveDefaultCatalogModelOption', () => {
  it('selects the first model in catalog response order for an empty node', () => {
    expect(resolveDefaultCatalogModelOption({
      currentValue: '',
      options,
      loading: false,
      error: null,
    })).toBe(options[0])
  })

  it('preserves an explicit model already stored on the node', () => {
    expect(resolveDefaultCatalogModelOption({
      currentValue: 'catalog-second',
      options,
      loading: false,
      error: null,
    })).toBeNull()
  })

  it('replaces a stale hard-coded model with the first live model-service row', () => {
    expect(resolveDefaultCatalogModelOption({
      currentValue: 'gpt-image-2',
      options,
      loading: false,
      error: null,
    })).toBe(options[0])
  })

  it('does not invent a default while the catalog is unavailable', () => {
    expect(resolveDefaultCatalogModelOption({
      currentValue: '',
      options,
      loading: true,
      error: null,
    })).toBeNull()
    expect(resolveDefaultCatalogModelOption({
      currentValue: '',
      options,
      loading: false,
      error: new Error('catalog unavailable'),
    })).toBeNull()
  })
})

describe('resolveCatalogActionModelOption', () => {
  it('uses the current live catalog model when an old action model is unavailable', () => {
    expect(resolveCatalogActionModelOption({
      options,
      requestedValue: 'gpt-image-2',
      currentValue: 'catalog-second',
    })).toBe(options[1])
  })

  it('falls back to the first live catalog row instead of inventing a frontend model', () => {
    expect(resolveCatalogActionModelOption({
      options: [{
        value: 'live-image-alias',
        label: '模型服务唯一可用图片模型',
        modelKey: 'provider:live-image-request-key',
      }],
      requestedValue: 'gemini-3.1-flash-image-preview',
      currentValue: 'gpt-image-2',
    })?.modelKey).toBe('provider:live-image-request-key')
  })

  it('preserves an explicitly requested action model when it is still live', () => {
    expect(resolveCatalogActionModelOption({
      options,
      requestedValue: 'catalog-second',
      currentValue: 'catalog-first',
    })).toBe(options[1])
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('GenerationPrefsModal copy', () => {
  it('describes live model-service defaults without advertising hard-coded models', () => {
    const source = readFileSync(new URL('./GenerationPrefsModal.tsx', import.meta.url), 'utf8')

    expect(source).not.toContain('新账号初始使用 gpt-image-2')
    expect(source).not.toContain('minimax-h3 / 768p')
    expect(source).toContain('模型服务')
  })
})

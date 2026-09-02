import type { ModelOption } from '../../../config/models'
import { findModelOptionByIdentifier } from '../../../config/useModelOptions'

export type DefaultCatalogModelInput = {
  currentValue: string
  options: readonly ModelOption[]
  loading: boolean
  error: Error | null
}

/**
 * 仅保留仍存在于实时模型目录中的显式值。
 * 新节点或残留旧硬编码模型统一采用系统模型服务返回的第一项。
 */
export function resolveDefaultCatalogModelOption(
  input: DefaultCatalogModelInput,
): ModelOption | null {
  if (input.loading || input.error) return null
  const currentValue = input.currentValue.trim()
  if (currentValue && findModelOptionByIdentifier(input.options, currentValue)) return null
  const firstOption = input.options[0]
  return firstOption && firstOption.value.trim() ? firstOption : null
}

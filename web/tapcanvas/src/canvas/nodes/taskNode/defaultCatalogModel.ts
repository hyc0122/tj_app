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

export type CatalogActionModelInput = {
  options: readonly ModelOption[]
  requestedValue?: string | null
  currentValue?: string | null
}

/**
 * 动作节点只从实时模型目录中选择模型。
 *
 * 优先使用动作显式请求，其次使用当前节点选择；两者都已下线时采用目录第一项。
 * 前端不再为打光、高清、扩图等动作写死供应商模型名。
 */
export function resolveCatalogActionModelOption(
  input: CatalogActionModelInput,
): ModelOption | null {
  const requested = findModelOptionByIdentifier(input.options, input.requestedValue)
  if (requested) return requested

  const current = findModelOptionByIdentifier(input.options, input.currentValue)
  if (current) return current

  const firstOption = input.options[0]
  return firstOption && firstOption.value.trim() ? firstOption : null
}

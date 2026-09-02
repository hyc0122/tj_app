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
  /** 需要服务端目录明确声明的动作能力；存在时禁止回退普通生成模型。 */
  requiredActionKey?: string | null
}

function normalizeCatalogActionKey(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    : ''
}

function collectCatalogActionKeys(option: ModelOption): string[] {
  const meta = option.meta && typeof option.meta === 'object' && !Array.isArray(option.meta)
    ? option.meta as Record<string, unknown>
    : {}
  const values: unknown[] = [
    meta.actionKey,
    meta.action,
    meta.operation,
    meta.capability,
    meta.actionKeys,
    meta.actions,
    meta.operations,
    meta.capabilities,
    meta.tags,
    meta.endpoints,
    meta.runtimeEndpoints,
  ]
  return values.flatMap((value) => Array.isArray(value) ? value : [value])
    .map(normalizeCatalogActionKey)
    .filter(Boolean)
}

/** 只接受目录元数据明确声明的动作能力，不根据供应商模型名猜测。 */
export function doesCatalogOptionSupportAction(option: ModelOption, actionKey: string): boolean {
  const required = normalizeCatalogActionKey(actionKey)
  if (!required) return false
  return collectCatalogActionKeys(option).some((candidate) =>
    candidate === required || candidate.endsWith(`_${required}`),
  )
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
  const requiredActionKey = normalizeCatalogActionKey(input.requiredActionKey)
  if (requiredActionKey) {
    return input.options.find((option) => doesCatalogOptionSupportAction(option, requiredActionKey)) ?? null
  }

  const requested = findModelOptionByIdentifier(input.options, input.requestedValue)
  if (requested) return requested

  const current = findModelOptionByIdentifier(input.options, input.currentValue)
  if (current) return current

  const firstOption = input.options[0]
  return firstOption && firstOption.value.trim() ? firstOption : null
}

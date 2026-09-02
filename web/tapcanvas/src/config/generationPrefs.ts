// 用户全局生成偏好的前端缓存：模块级单例 + 变更事件。
// 消费方：① 画布在动态模型目录加载完成后校验并采用偏好 ② 生成偏好弹窗回显。
// 服务端真相源 = users.generation_prefs（小T 上下文注入走服务端，不依赖本缓存）。
import { getGenerationPreferences, putGenerationPreferences, type UserGenerationPrefsDto } from '../api/server'
import type { ModelOption } from './models'

export const GENERATION_PREFS_EVENT = 'tapcanvas-generation-prefs-changed'

export const DEFAULT_GENERATION_PREFS: Readonly<Required<UserGenerationPrefsDto>> = {
  imageModel: '',
  imageSize: '1K',
  videoModel: '',
  videoResolution: '768p',
  videoAspect: '16:9',
}

/**
 * 画布下拉框保存稳定显示值，账号偏好必须保存模型服务发布的真实请求路由键。
 * 禁止在缺少路由键时退回显示别名，否则下一次生成仍可能绕过系统模型映射。
 */
export function toGenerationPreferenceModelPatch(
  field: 'imageModel' | 'videoModel',
  option: ModelOption,
): UserGenerationPrefsDto {
  const requestModelKey = String(option.modelKey || '').trim()
  if (!requestModelKey) throw new Error(`模型 ${option.label || option.value} 缺少系统请求路由键`)
  return { [field]: requestModelKey }
}

let cachedPrefs: UserGenerationPrefsDto | null = null
let loaded = false
let inflight: Promise<UserGenerationPrefsDto | null> | null = null
let updateQueue: Promise<void> = Promise.resolve()

/** 同步读缓存（未加载过返回 null；消费方仍须用动态目录校验模型是否可用）。 */
export function getCachedGenerationPrefs(): UserGenerationPrefsDto | null {
  return cachedPrefs
}

function emitChanged() {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(GENERATION_PREFS_EVENT, { detail: cachedPrefs }))
  }
}

/** 拉取并缓存（幂等去重）；读取失败向调用方暴露，禁止伪装成“新账号无偏好”。 */
export async function loadGenerationPrefs(force = false): Promise<UserGenerationPrefsDto | null> {
  if (loaded && !force) return cachedPrefs
  if (inflight) return inflight
  inflight = (async () => {
    try {
      cachedPrefs = await getGenerationPreferences()
      loaded = true
      emitChanged()
      return cachedPrefs
    } catch (error) {
      throw error
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** 保存到服务端并更新缓存。 */
export async function saveGenerationPrefs(prefs: UserGenerationPrefsDto): Promise<UserGenerationPrefsDto | null> {
  cachedPrefs = await putGenerationPreferences(prefs)
  loaded = true
  emitChanged()
  return cachedPrefs
}

/**
 * 依调用顺序把用户刚刚明确选择的字段合并到账号偏好。
 * 服务端负责字段级合并；串行队列确保同一页面内连续操作不会因响应乱序覆盖“最近一次选择”。
 */
export function updateRecentGenerationPrefs(
  patch: UserGenerationPrefsDto,
): Promise<UserGenerationPrefsDto | null> {
  const operation = updateQueue
    .catch(() => undefined)
    .then(() => saveGenerationPrefs(patch))
  updateQueue = operation.then(
    () => undefined,
    () => undefined,
  )
  return operation
}

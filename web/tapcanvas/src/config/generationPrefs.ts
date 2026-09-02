// 用户全局生成偏好的前端缓存：模块级单例 + 变更事件。
// 消费方：① 画布在动态模型目录加载完成后校验并采用偏好 ② 生成偏好弹窗回显。
// 服务端真相源 = users.generation_prefs（小T 上下文注入走服务端，不依赖本缓存）。
import { getGenerationPreferences, putGenerationPreferences, type UserGenerationPrefsDto } from '../api/server'
import { useAuth } from '../auth/store'
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

type GenerationPrefsRuntimeState = {
  scopeKey: string
  generation: number
  cachedPrefs: UserGenerationPrefsDto | null
  loaded: boolean
  revision: number
  inflight: Promise<UserGenerationPrefsDto | null> | null
  updateQueue: Promise<void>
}

export type GenerationPrefsRuntime = {
  getCached: () => UserGenerationPrefsDto | null
  load: (force?: boolean) => Promise<UserGenerationPrefsDto | null>
  save: (prefs: UserGenerationPrefsDto) => Promise<UserGenerationPrefsDto | null>
  updateRecent: (patch: UserGenerationPrefsDto) => Promise<UserGenerationPrefsDto | null>
}

export type GenerationPrefsRuntimeInput = {
  read: () => Promise<UserGenerationPrefsDto | null>
  write: (prefs: UserGenerationPrefsDto) => Promise<UserGenerationPrefsDto | null>
  getScopeKey: () => string
  onChanged?: (prefs: UserGenerationPrefsDto | null) => void
}

/**
 * 创建按账号隔离的生成偏好运行时。
 *
 * 账号变化会立即丢弃上一账号的内存缓存；GET 通过 revision 防止覆盖较新的 PUT，
 * 所有保存入口共用同一串行队列，避免弹窗保存和节点最近选择互相覆盖。
 */
export function createGenerationPrefsRuntime(
  input: GenerationPrefsRuntimeInput,
): GenerationPrefsRuntime {
  let generation = 0
  let activeState: GenerationPrefsRuntimeState | null = null

  const readScopeKey = (): string => input.getScopeKey().trim() || 'signed-out'
  const getActiveState = (): GenerationPrefsRuntimeState => {
    const scopeKey = readScopeKey()
    if (!activeState || activeState.scopeKey !== scopeKey) {
      generation += 1
      activeState = {
        scopeKey,
        generation,
        cachedPrefs: null,
        loaded: false,
        revision: 0,
        inflight: null,
        updateQueue: Promise.resolve(),
      }
    }
    return activeState
  }
  const isCurrentState = (state: GenerationPrefsRuntimeState): boolean => {
    return getActiveState() === state && state.generation === generation
  }

  const getCached = (): UserGenerationPrefsDto | null => getActiveState().cachedPrefs

  const load = (force = false): Promise<UserGenerationPrefsDto | null> => {
    const state = getActiveState()
    if (state.loaded && !force) return Promise.resolve(state.cachedPrefs)
    if (state.inflight) return state.inflight

    const readRevision = state.revision
    let request!: Promise<UserGenerationPrefsDto | null>
    request = (async (): Promise<UserGenerationPrefsDto | null> => {
      try {
        const result = await input.read()
        if (!isCurrentState(state)) return null
        if (state.revision !== readRevision) return state.cachedPrefs
        state.cachedPrefs = result
        state.loaded = true
        input.onChanged?.(result)
        return result
      } finally {
        if (state.inflight === request) state.inflight = null
      }
    })()
    state.inflight = request
    return request
  }

  const save = (prefs: UserGenerationPrefsDto): Promise<UserGenerationPrefsDto | null> => {
    const state = getActiveState()
    const operation = state.updateQueue
      .catch(() => undefined)
      .then(async () => {
        const result = await input.write(prefs)
        if (!isCurrentState(state)) return null
        state.revision += 1
        state.cachedPrefs = result
        state.loaded = true
        input.onChanged?.(result)
        return result
      })
    state.updateQueue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  return {
    getCached,
    load,
    save,
    updateRecent: save,
  }
}

/** 同步读缓存（未加载过返回 null；消费方仍须用动态目录校验模型是否可用）。 */
function emitChanged(prefs: UserGenerationPrefsDto | null) {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(GENERATION_PREFS_EVENT, { detail: prefs }))
  }
}

function getCurrentGenerationPrefsScopeKey(): string {
  const auth = useAuth.getState()
  const userId = String(auth.user?.sub ?? '').trim()
  return auth.token && userId ? `user:${userId}` : 'signed-out'
}

const generationPrefsRuntime = createGenerationPrefsRuntime({
  read: getGenerationPreferences,
  write: putGenerationPreferences,
  getScopeKey: getCurrentGenerationPrefsScopeKey,
  onChanged: emitChanged,
})

/** 同步读当前账号缓存（未加载过返回 null；消费方仍须用动态目录校验模型是否可用）。 */
export function getCachedGenerationPrefs(): UserGenerationPrefsDto | null {
  return generationPrefsRuntime.getCached()
}

/** 拉取并缓存（幂等去重）；读取失败向调用方暴露，禁止伪装成“新账号无偏好”。 */
export async function loadGenerationPrefs(force = false): Promise<UserGenerationPrefsDto | null> {
  return generationPrefsRuntime.load(force)
}

/** 保存到服务端并更新缓存。 */
export async function saveGenerationPrefs(prefs: UserGenerationPrefsDto): Promise<UserGenerationPrefsDto | null> {
  return generationPrefsRuntime.save(prefs)
}

/**
 * 依调用顺序把用户刚刚明确选择的字段合并到账号偏好。
 * 服务端负责字段级合并；串行队列确保同一页面内连续操作不会因响应乱序覆盖“最近一次选择”。
 */
export function updateRecentGenerationPrefs(
  patch: UserGenerationPrefsDto,
): Promise<UserGenerationPrefsDto | null> {
  return generationPrefsRuntime.updateRecent(patch)
}

type FlagTuple = readonly [boolean, (value: boolean) => void]

export function useRegisterSW(_options?: {
  onNeedReload?: () => void
}): {
  needRefresh: FlagTuple
  offlineReady: FlagTuple
  updateServiceWorker: (reload?: boolean) => Promise<void>
} {
  const noop = (_value: boolean): void => undefined
  return {
    needRefresh: [false, noop],
    offlineReady: [false, noop],
    updateServiceWorker: async () => undefined,
  }
}

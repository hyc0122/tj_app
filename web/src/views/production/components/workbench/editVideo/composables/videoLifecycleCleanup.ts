interface DisposableVideoContext {
  spriteListenerMap: Map<string, () => void>;
  clipSpriteMap: Map<string, unknown>;
  clipSnapshotMap: Map<string, unknown>;
  clipTrackMap: Map<string, unknown>;
  transitionInfoMap: Map<string, unknown>;
  clipTransitionsMap: Map<string, unknown>;
  clipFrameCache: Map<string, { close: () => void }>;
  avCanvas: { value: { destroy: () => void } | null };
}

export function clearVideoFrameCache(context: Pick<DisposableVideoContext, "clipFrameCache">) {
  context.clipFrameCache.forEach((frame) => frame.close());
  context.clipFrameCache.clear();
}

/**
 * 先解除 sprite 监听，再释放缓存帧，最后销毁 Canvas，避免回调访问已释放资源。
 */
export function disposeVideoPreviewResources(context: DisposableVideoContext) {
  context.spriteListenerMap.forEach((unsubscribe) => unsubscribe());
  context.spriteListenerMap.clear();
  context.clipSpriteMap.clear();
  context.clipSnapshotMap.clear();
  context.clipTrackMap.clear();
  context.transitionInfoMap.clear();
  context.clipTransitionsMap.clear();
  clearVideoFrameCache(context);
  context.avCanvas.value?.destroy();
  context.avCanvas.value = null;
}

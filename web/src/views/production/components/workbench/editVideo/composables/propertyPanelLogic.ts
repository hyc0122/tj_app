export function readVideoPropertyValues(clip: Record<string, any>) {
  return {
    opacity: Math.round((clip.opacity ?? 1) * 100),
    volume: Math.round((clip.volume ?? 1) * 100),
    playbackRate: clip.playbackRate ?? 1,
  };
}

export function calculateCenteredTransitionRange(startTime: number, endTime: number, duration: number) {
  const center = (startTime + endTime) / 2;
  return {
    startTime: center - duration / 2,
    endTime: center + duration / 2,
    transitionDuration: duration,
  };
}

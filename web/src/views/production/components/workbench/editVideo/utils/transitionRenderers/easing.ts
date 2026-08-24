// ============ 缓动函数 ============

/**
 * 线性缓动
 */
export function easeLinear(t: number): number {
  return t;
}

/**
 * 二次缓动 - 先慢后快再慢
 */
export function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * 三次缓动 - 更平滑的加减速
 */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

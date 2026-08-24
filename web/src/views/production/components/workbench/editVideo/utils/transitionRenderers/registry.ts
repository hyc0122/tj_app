import type { TransitionRenderer } from "./types";
import { fadeTransition, dissolveTransition, slideLeftTransition, slideRightTransition, slideUpTransition, slideDownTransition } from "./basic";
import { wipeLeftTransition, wipeRightTransition, wipeUpTransition, wipeDownTransition } from "./wipes";
import { zoomInTransition, zoomOutTransition, rotateTransition } from "./transforms";
import { circleTransition, diamondTransition, clockTransition, blurTransition } from "./masks";

export { fadeTransition, dissolveTransition, slideLeftTransition, slideRightTransition, slideUpTransition, slideDownTransition } from "./basic";
export { wipeLeftTransition, wipeRightTransition, wipeUpTransition, wipeDownTransition } from "./wipes";
export { zoomInTransition, zoomOutTransition, rotateTransition } from "./transforms";
export { circleTransition, diamondTransition, clockTransition, blurTransition } from "./masks";

// ============ 转场渲染器注册表 ============

/**
 * 转场渲染器映射表
 */
export const transitionRenderers: Record<string, TransitionRenderer> = {
  fade: fadeTransition,
  dissolve: dissolveTransition,
  slide: slideLeftTransition, // 默认滑动方向
  "slide-left": slideLeftTransition,
  "slide-right": slideRightTransition,
  "slide-up": slideUpTransition,
  "slide-down": slideDownTransition,
  wipe: wipeRightTransition, // 默认擦除方向
  "wipe-left": wipeLeftTransition,
  "wipe-right": wipeRightTransition,
  "wipe-up": wipeUpTransition,
  "wipe-down": wipeDownTransition,
  zoom: zoomInTransition, // 默认放大
  "zoom-in": zoomInTransition,
  "zoom-out": zoomOutTransition,
  rotate: rotateTransition,
  circle: circleTransition,
  diamond: diamondTransition,
  clock: clockTransition,
  blur: blurTransition,
};

/**
 * 获取转场渲染器
 * @param type 转场类型
 * @returns 对应的渲染器，如果类型未知则返回默认的淡入淡出
 */
export function getTransitionRenderer(type: string): TransitionRenderer {
  return transitionRenderers[type] || fadeTransition;
}

/**
 * 获取所有支持的转场类型
 */
export function getSupportedTransitionTypes(): string[] {
  return Object.keys(transitionRenderers);
}

/**
 * 转场类型的 i18n key 映射
 */
const transitionTypeKeys: Record<string, string> = {
  fade: "workbench.production.transition.fade",
  dissolve: "workbench.production.transition.dissolve",
  slide: "workbench.production.transition.slide",
  "slide-left": "workbench.production.transition.slideLeft",
  "slide-right": "workbench.production.transition.slideRight",
  "slide-up": "workbench.production.transition.slideUp",
  "slide-down": "workbench.production.transition.slideDown",
  wipe: "workbench.production.transition.wipe",
  "wipe-left": "workbench.production.transition.wipeLeft",
  "wipe-right": "workbench.production.transition.wipeRight",
  "wipe-up": "workbench.production.transition.wipeUp",
  "wipe-down": "workbench.production.transition.wipeDown",
  zoom: "workbench.production.transition.zoom",
  "zoom-in": "workbench.production.transition.zoomIn",
  "zoom-out": "workbench.production.transition.zoomOut",
  rotate: "workbench.production.transition.rotate",
  circle: "workbench.production.transition.circle",
  diamond: "workbench.production.transition.diamond",
  clock: "workbench.production.transition.clock",
  blur: "workbench.production.transition.blur",
};

export function getTransitionTypeName(type: string): string {
  const key = transitionTypeKeys[type];
  return key ? $t(key) : type;
}

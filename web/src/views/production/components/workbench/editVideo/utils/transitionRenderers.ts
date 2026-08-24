/**
 * 保留原公共入口，调用方无需感知渲染器已按职责拆分。
 */
export type { TransitionRenderer, TransitionType } from "./transitionRenderers/types";
export * from "./transitionRenderers/basic";
export * from "./transitionRenderers/wipes";
export * from "./transitionRenderers/transforms";
export * from "./transitionRenderers/masks";
export {
  transitionRenderers,
  getTransitionRenderer,
  getSupportedTransitionTypes,
  getTransitionTypeName,
} from "./transitionRenderers/registry";

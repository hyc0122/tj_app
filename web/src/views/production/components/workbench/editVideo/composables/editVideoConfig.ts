import type { OperationButton, ScaleConfigButton, TrackTypeConfig } from "vue-clip-track";
import { toRefs } from "vue";

/**
 * 页面只向视图区块暴露 props 的响应式引用，避免父级替换素材数组后子区块仍持有旧值。
 */
export function createEditVideoPropBindings<T extends object>(props: T) {
  return toRefs(props);
}

export const operationButtons: OperationButton[] = [
  { type: "custom", key: "reset" },
  { type: "custom", key: "undo" },
  { type: "custom", key: "redo" },
  { type: "custom", key: "split" },
  { type: "custom", key: "delete" },
  { type: "custom", key: "import" },
];

export const scaleConfigButtons: ScaleConfigButton[] = ["snap"];

export const trackTypes: TrackTypeConfig = {
  video: { max: 5 },
  image: { max: 3 },
  audio: { max: 3 },
  subtitle: { max: 2 },
  text: { max: 2 },
  sticker: { max: 2 },
  filter: { max: 1 },
  effect: { max: 2 },
};

export const clipConfigs = {
  video: {
    backgroundColor: "linear-gradient(45deg, #667eea 0%, #764ba2 100%)",
    borderColor: "#000000",
    height: 60,
    selected: {
      borderColor: "#ff6b6b",
      boxShadow: "0 0 0 3px rgba(255, 107, 107, 0.3)",
    },
  },
  audio: {
    backgroundColor: "linear-gradient(45deg, #f093fb 0%, #f5576c 100%)",
    height: 36,
    selected: { borderColor: "#4ecdc4" },
  },
  image: {
    backgroundColor: "linear-gradient(45deg, #43e97b 0%, #38f9d7 100%)",
    borderColor: "#43e97b",
    height: 60,
    selected: {
      borderColor: "#ff6b6b",
      boxShadow: "0 0 0 3px rgba(255, 107, 107, 0.3)",
    },
  },
};

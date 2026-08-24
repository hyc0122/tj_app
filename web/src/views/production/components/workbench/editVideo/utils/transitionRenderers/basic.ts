import type { TransitionRenderer } from "./types";
import { easeInOutCubic } from "./easing";

/**
 * 淡入淡出转场
 * 前一帧渐隐，后一帧渐显
 */
export const fadeTransition: TransitionRenderer = {
  render(ctx, frameA, frameB, progress, width, height) {
    ctx.clearRect(0, 0, width, height);

    // 绘制 frameA（渐隐）
    if (frameA) {
      ctx.globalAlpha = 1 - progress;
      ctx.drawImage(frameA, 0, 0, width, height);
    }

    // 绘制 frameB（渐显）
    if (frameB) {
      ctx.globalAlpha = progress;
      ctx.drawImage(frameB, 0, 0, width, height);
    }

    ctx.globalAlpha = 1;
  },
};

/**
 * 溶解转场
 * 类似淡入淡出，但使用叠加混合模式
 */
export const dissolveTransition: TransitionRenderer = {
  render(ctx, frameA, frameB, progress, width, height) {
    ctx.clearRect(0, 0, width, height);

    // 绘制 frameA
    if (frameA) {
      ctx.globalAlpha = 1;
      ctx.drawImage(frameA, 0, 0, width, height);
    }

    // 使用 source-atop 混合模式绘制 frameB
    if (frameB) {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = progress;
      ctx.drawImage(frameB, 0, 0, width, height);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  },
};

/**
 * 向左滑动转场
 * frameA 向左滑出，frameB 从右侧滑入
 */
export const slideLeftTransition: TransitionRenderer = {
  render(ctx, frameA, frameB, progress, width, height) {
    ctx.clearRect(0, 0, width, height);

    // 使用缓动函数让动画更自然
    const easedProgress = easeInOutCubic(progress);
    const slideX = width * easedProgress;

    // frameA 向左滑出
    if (frameA) {
      ctx.globalAlpha = 1;
      ctx.drawImage(frameA, -slideX, 0, width, height);
    }

    // frameB 从右侧滑入
    if (frameB) {
      ctx.globalAlpha = 1;
      ctx.drawImage(frameB, width - slideX, 0, width, height);
    }
  },
};

/**
 * 向右滑动转场
 * frameA 向右滑出，frameB 从左侧滑入
 */
export const slideRightTransition: TransitionRenderer = {
  render(ctx, frameA, frameB, progress, width, height) {
    ctx.clearRect(0, 0, width, height);

    const easedProgress = easeInOutCubic(progress);
    const slideX = width * easedProgress;

    // frameA 向右滑出
    if (frameA) {
      ctx.globalAlpha = 1;
      ctx.drawImage(frameA, slideX, 0, width, height);
    }

    // frameB 从左侧滑入
    if (frameB) {
      ctx.globalAlpha = 1;
      ctx.drawImage(frameB, -width + slideX, 0, width, height);
    }
  },
};

/**
 * 向上滑动转场
 * frameA 向上滑出，frameB 从下方滑入
 */
export const slideUpTransition: TransitionRenderer = {
  render(ctx, frameA, frameB, progress, width, height) {
    ctx.clearRect(0, 0, width, height);

    const easedProgress = easeInOutCubic(progress);
    const slideY = height * easedProgress;

    // frameA 向上滑出
    if (frameA) {
      ctx.globalAlpha = 1;
      ctx.drawImage(frameA, 0, -slideY, width, height);
    }

    // frameB 从下方滑入
    if (frameB) {
      ctx.globalAlpha = 1;
      ctx.drawImage(frameB, 0, height - slideY, width, height);
    }
  },
};

/**
 * 向下滑动转场
 * frameA 向下滑出，frameB 从上方滑入
 */
export const slideDownTransition: TransitionRenderer = {
  render(ctx, frameA, frameB, progress, width, height) {
    ctx.clearRect(0, 0, width, height);

    const easedProgress = easeInOutCubic(progress);
    const slideY = height * easedProgress;

    // frameA 向下滑出
    if (frameA) {
      ctx.globalAlpha = 1;
      ctx.drawImage(frameA, 0, slideY, width, height);
    }

    // frameB 从上方滑入
    if (frameB) {
      ctx.globalAlpha = 1;
      ctx.drawImage(frameB, 0, -height + slideY, width, height);
    }
  },
};

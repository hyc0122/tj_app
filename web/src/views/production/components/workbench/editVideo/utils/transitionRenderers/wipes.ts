import type { TransitionRenderer } from "./types";
import { easeInOutQuad } from "./easing";

/**
 * 向左擦除转场
 * 从右向左逐渐显示 frameB
 */
export const wipeLeftTransition: TransitionRenderer = {
  render(ctx, frameA, frameB, progress, width, height) {
    ctx.clearRect(0, 0, width, height);

    const easedProgress = easeInOutQuad(progress);
    const wipeX = width * easedProgress;

    // 先绘制 frameA 作为底层
    if (frameA) {
      ctx.globalAlpha = 1;
      ctx.drawImage(frameA, 0, 0, width, height);
    }

    // 使用裁剪区域绘制 frameB（从右向左）
    if (frameB) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(width - wipeX, 0, wipeX, height);
      ctx.clip();
      ctx.drawImage(frameB, 0, 0, width, height);
      ctx.restore();
    }
  },
};

/**
 * 向右擦除转场
 * 从左向右逐渐显示 frameB
 */
export const wipeRightTransition: TransitionRenderer = {
  render(ctx, frameA, frameB, progress, width, height) {
    ctx.clearRect(0, 0, width, height);

    const easedProgress = easeInOutQuad(progress);
    const wipeX = width * easedProgress;

    // 先绘制 frameA 作为底层
    if (frameA) {
      ctx.globalAlpha = 1;
      ctx.drawImage(frameA, 0, 0, width, height);
    }

    // 使用裁剪区域绘制 frameB（从左向右）
    if (frameB) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, wipeX, height);
      ctx.clip();
      ctx.drawImage(frameB, 0, 0, width, height);
      ctx.restore();
    }
  },
};

/**
 * 向上擦除转场
 * 从下向上逐渐显示 frameB
 */
export const wipeUpTransition: TransitionRenderer = {
  render(ctx, frameA, frameB, progress, width, height) {
    ctx.clearRect(0, 0, width, height);

    const easedProgress = easeInOutQuad(progress);
    const wipeY = height * easedProgress;

    // 先绘制 frameA 作为底层
    if (frameA) {
      ctx.globalAlpha = 1;
      ctx.drawImage(frameA, 0, 0, width, height);
    }

    // 使用裁剪区域绘制 frameB（从下向上）
    if (frameB) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, height - wipeY, width, wipeY);
      ctx.clip();
      ctx.drawImage(frameB, 0, 0, width, height);
      ctx.restore();
    }
  },
};

/**
 * 向下擦除转场
 * 从上向下逐渐显示 frameB
 */
export const wipeDownTransition: TransitionRenderer = {
  render(ctx, frameA, frameB, progress, width, height) {
    ctx.clearRect(0, 0, width, height);

    const easedProgress = easeInOutQuad(progress);
    const wipeY = height * easedProgress;

    // 先绘制 frameA 作为底层
    if (frameA) {
      ctx.globalAlpha = 1;
      ctx.drawImage(frameA, 0, 0, width, height);
    }

    // 使用裁剪区域绘制 frameB（从上向下）
    if (frameB) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, width, wipeY);
      ctx.clip();
      ctx.drawImage(frameB, 0, 0, width, height);
      ctx.restore();
    }
  },
};

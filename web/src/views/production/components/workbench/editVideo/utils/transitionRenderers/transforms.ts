import type { TransitionRenderer } from "./types";
import { easeInOutCubic } from "./easing";

/**
 * 放大转场
 * frameB 从中心放大覆盖 frameA
 */
export const zoomInTransition: TransitionRenderer = {
  render(ctx, frameA, frameB, progress, width, height) {
    ctx.clearRect(0, 0, width, height);

    const easedProgress = easeInOutCubic(progress);

    // 先绘制 frameA 作为底层
    if (frameA) {
      ctx.globalAlpha = 1 - easedProgress * 0.5;
      ctx.drawImage(frameA, 0, 0, width, height);
    }

    // frameB 从中心放大
    if (frameB) {
      const scale = easedProgress;
      const scaledWidth = width * scale;
      const scaledHeight = height * scale;
      const offsetX = (width - scaledWidth) / 2;
      const offsetY = (height - scaledHeight) / 2;

      ctx.globalAlpha = easedProgress;
      ctx.drawImage(frameB, offsetX, offsetY, scaledWidth, scaledHeight);
    }

    ctx.globalAlpha = 1;
  },
};

/**
 * 缩小转场
 * frameA 缩小消失，显示 frameB
 */
export const zoomOutTransition: TransitionRenderer = {
  render(ctx, frameA, frameB, progress, width, height) {
    ctx.clearRect(0, 0, width, height);

    const easedProgress = easeInOutCubic(progress);

    // 先绘制 frameB 作为底层
    if (frameB) {
      ctx.globalAlpha = 1;
      ctx.drawImage(frameB, 0, 0, width, height);
    }

    // frameA 缩小
    if (frameA) {
      const scale = 1 - easedProgress;
      const scaledWidth = width * scale;
      const scaledHeight = height * scale;
      const offsetX = (width - scaledWidth) / 2;
      const offsetY = (height - scaledHeight) / 2;

      ctx.globalAlpha = 1 - easedProgress;
      ctx.drawImage(frameA, offsetX, offsetY, scaledWidth, scaledHeight);
    }

    ctx.globalAlpha = 1;
  },
};

/**
 * 旋转转场
 * frameA 旋转消失，frameB 旋转出现
 */
export const rotateTransition: TransitionRenderer = {
  render(ctx, frameA, frameB, progress, width, height) {
    ctx.clearRect(0, 0, width, height);

    const easedProgress = easeInOutCubic(progress);
    const centerX = width / 2;
    const centerY = height / 2;

    // frameA 旋转消失
    if (frameA && progress < 0.5) {
      const angle = easedProgress * Math.PI; // 0 到 180度
      const scale = 1 - easedProgress * 2;

      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(angle);
      ctx.scale(Math.max(0.01, scale), Math.max(0.01, scale));
      ctx.translate(-centerX, -centerY);
      ctx.globalAlpha = 1 - easedProgress * 2;
      ctx.drawImage(frameA, 0, 0, width, height);
      ctx.restore();
    }

    // frameB 旋转出现
    if (frameB && progress >= 0.5) {
      const angle = (easedProgress - 0.5) * Math.PI * 2 - Math.PI; // -180到0度
      const scale = (easedProgress - 0.5) * 2;

      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(angle);
      ctx.scale(Math.max(0.01, scale), Math.max(0.01, scale));
      ctx.translate(-centerX, -centerY);
      ctx.globalAlpha = (easedProgress - 0.5) * 2;
      ctx.drawImage(frameB, 0, 0, width, height);
      ctx.restore();
    }

    ctx.globalAlpha = 1;
  },
};

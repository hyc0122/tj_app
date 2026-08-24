import type { TransitionRenderer } from "./types";
import { easeInOutQuad, easeLinear } from "./easing";

/**
 * 圆形遮罩转场
 * 从中心向外扩展的圆形显示 frameB
 */
export const circleTransition: TransitionRenderer = {
  render(ctx, frameA, frameB, progress, width, height) {
    ctx.clearRect(0, 0, width, height);

    const easedProgress = easeInOutQuad(progress);
    const centerX = width / 2;
    const centerY = height / 2;
    // 计算对角线长度作为最大半径
    const maxRadius = Math.sqrt(centerX * centerX + centerY * centerY);
    const radius = maxRadius * easedProgress;

    // 先绘制 frameA 作为底层
    if (frameA) {
      ctx.globalAlpha = 1;
      ctx.drawImage(frameA, 0, 0, width, height);
    }

    // 使用圆形裁剪绘制 frameB
    if (frameB) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(frameB, 0, 0, width, height);
      ctx.restore();
    }
  },
};

/**
 * 菱形遮罩转场
 * 从中心向外扩展的菱形显示 frameB
 */
export const diamondTransition: TransitionRenderer = {
  render(ctx, frameA, frameB, progress, width, height) {
    ctx.clearRect(0, 0, width, height);

    const easedProgress = easeInOutQuad(progress);
    const centerX = width / 2;
    const centerY = height / 2;
    const maxSize = Math.max(width, height);
    const size = maxSize * easedProgress;

    // 先绘制 frameA 作为底层
    if (frameA) {
      ctx.globalAlpha = 1;
      ctx.drawImage(frameA, 0, 0, width, height);
    }

    // 使用菱形裁剪绘制 frameB
    if (frameB) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(centerX, centerY - size); // 上
      ctx.lineTo(centerX + size, centerY); // 右
      ctx.lineTo(centerX, centerY + size); // 下
      ctx.lineTo(centerX - size, centerY); // 左
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(frameB, 0, 0, width, height);
      ctx.restore();
    }
  },
};

/**
 * 时钟擦除转场
 * 像时钟指针一样扫过显示 frameB
 */
export const clockTransition: TransitionRenderer = {
  render(ctx, frameA, frameB, progress, width, height) {
    ctx.clearRect(0, 0, width, height);

    const easedProgress = easeLinear(progress);
    const centerX = width / 2;
    const centerY = height / 2;
    const maxRadius = Math.sqrt(centerX * centerX + centerY * centerY) * 1.5;
    const angle = easedProgress * Math.PI * 2 - Math.PI / 2; // 从12点钟方向开始

    // 先绘制 frameA 作为底层
    if (frameA) {
      ctx.globalAlpha = 1;
      ctx.drawImage(frameA, 0, 0, width, height);
    }

    // 使用扇形裁剪绘制 frameB
    if (frameB) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.arc(centerX, centerY, maxRadius, -Math.PI / 2, angle, false);
      ctx.lineTo(centerX, centerY);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(frameB, 0, 0, width, height);
      ctx.restore();
    }
  },
};

/**
 * 模糊过渡转场
 * 通过模糊效果进行过渡（注意：Canvas 2D 的 filter 性能开销较大）
 */
export const blurTransition: TransitionRenderer = {
  render(ctx, frameA, frameB, progress, width, height) {
    ctx.clearRect(0, 0, width, height);

    const maxBlur = 20;
    const blurA = progress * maxBlur;
    const blurB = (1 - progress) * maxBlur;

    // 绘制 frameA（渐隐 + 模糊）
    if (frameA) {
      ctx.save();
      ctx.filter = `blur(${blurA}px)`;
      ctx.globalAlpha = 1 - progress;
      ctx.drawImage(frameA, 0, 0, width, height);
      ctx.restore();
    }

    // 绘制 frameB（渐显 + 清晰）
    if (frameB) {
      ctx.save();
      ctx.filter = `blur(${blurB}px)`;
      ctx.globalAlpha = progress;
      ctx.drawImage(frameB, 0, 0, width, height);
      ctx.restore();
    }

    ctx.globalAlpha = 1;
    ctx.filter = "none";
  },
};

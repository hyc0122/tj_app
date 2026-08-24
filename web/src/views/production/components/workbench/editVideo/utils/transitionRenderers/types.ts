/**
 * 转场效果渲染器模块
 * 提供各种转场效果的帧级渲染实现
 */

/**
 * 转场渲染器接口
 */
export interface TransitionRenderer {
  /**
   * 渲染转场效果
   * @param ctx - OffscreenCanvas 2D 上下文
   * @param frameA - 前一个视频帧（转场开始前的 clip）
   * @param frameB - 后一个视频帧（转场结束后的 clip）
   * @param progress - 转场进度 0-1
   * @param width - 画布宽度
   * @param height - 画布高度
   */
  render(
    ctx: OffscreenCanvasRenderingContext2D,
    frameA: VideoFrame | ImageBitmap | null,
    frameB: VideoFrame | ImageBitmap | null,
    progress: number,
    width: number,
    height: number,
  ): void;
}

/**
 * 转场类型枚举
 */
export type TransitionType =
  | "fade" // 淡入淡出
  | "dissolve" // 溶解
  | "slide-left" // 向左滑动
  | "slide-right" // 向右滑动
  | "slide-up" // 向上滑动
  | "slide-down" // 向下滑动
  | "wipe-left" // 向左擦除
  | "wipe-right" // 向右擦除
  | "wipe-up" // 向上擦除
  | "wipe-down" // 向下擦除
  | "zoom-in" // 放大
  | "zoom-out" // 缩小
  | "rotate" // 旋转
  | "blur" // 模糊过渡
  | "pixelate" // 像素化过渡
  | "circle" // 圆形遮罩
  | "diamond" // 菱形遮罩
  | "clock"; // 时钟擦除

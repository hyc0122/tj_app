<template>
  <!-- 纯本地 CSS 动态网格渐变，不发起任何远程资源请求。 -->
  <div class="auth-backdrop" aria-hidden="true">
    <div class="auth-backdrop__wash" />
    <div class="auth-backdrop__blob auth-backdrop__blob--a" />
    <div class="auth-backdrop__blob auth-backdrop__blob--b" />
    <div class="auth-backdrop__blob auth-backdrop__blob--c" />
    <div class="auth-backdrop__grid" />
    <div class="auth-backdrop__noise" />
  </div>
</template>

<script setup lang="ts">
// 无脚本逻辑：动效与降级均在 CSS 中完成。
</script>

<style lang="scss" scoped>
.auth-backdrop {
  position: absolute;
  inset: 0;
  overflow: hidden;
  z-index: 0;
  pointer-events: none;
  background: linear-gradient(145deg, #c3e4ff 0%, #eae2ff 45%, #b9beff 100%);
}

.auth-backdrop__wash {
  position: absolute;
  inset: -10%;
  background:
    radial-gradient(circle at 20% 30%, rgba(110, 195, 244, 0.55), transparent 42%),
    radial-gradient(circle at 80% 20%, rgba(185, 190, 255, 0.5), transparent 40%),
    radial-gradient(circle at 50% 80%, rgba(234, 226, 255, 0.65), transparent 45%);
}

.auth-backdrop__blob {
  position: absolute;
  width: 48vmax;
  height: 48vmax;
  border-radius: 50%;
  filter: blur(40px);
  opacity: 0.55;
  animation: auth-drift 18s ease-in-out infinite alternate;
}

.auth-backdrop__blob--a {
  top: -18%;
  left: -12%;
  background: #6ec3f4;
}

.auth-backdrop__blob--b {
  right: -16%;
  top: 10%;
  background: #b9beff;
  animation-duration: 22s;
  animation-delay: -4s;
}

.auth-backdrop__blob--c {
  left: 20%;
  bottom: -22%;
  background: #c3e4ff;
  animation-duration: 26s;
  animation-delay: -8s;
}

.auth-backdrop__grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.22) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.22) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(circle at center, black 35%, transparent 85%);
  opacity: 0.35;
}

.auth-backdrop__noise {
  position: absolute;
  inset: 0;
  opacity: 0.07;
  /* 纯 CSS 噪点：不使用远程纹理或脚本绘制 */
  background-image: repeating-radial-gradient(
    circle at 17% 32%,
    rgba(255, 255, 255, 0.35) 0 0.5px,
    transparent 0.6px 3px
  );
  mix-blend-mode: soft-light;
}

@keyframes auth-drift {
  from {
    transform: translate3d(0, 0, 0) scale(1);
  }
  to {
    transform: translate3d(4%, -3%, 0) scale(1.06);
  }
}

@media (prefers-reduced-motion: reduce) {
  .auth-backdrop__blob {
    animation: none;
  }
}
</style>

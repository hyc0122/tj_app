<template>
  <div class="titleBar" role="banner">
    <div class="titleBar-title">
      <span class="titleBar-text">天将漫创</span>
    </div>
    <div class="titleBar-controls">
      <button
        type="button"
        class="titleBar-btn titleBar-btn--min"
        aria-label="最小化"
        @click="handleMinimize"
      >
        <span class="titleBar-orb" aria-hidden="true">
          <span class="titleBar-glyph">−</span>
        </span>
      </button>
      <button
        type="button"
        class="titleBar-btn titleBar-btn--max"
        :aria-label="isMaximized ? '还原' : '最大化'"
        @click="handleMaximize"
      >
        <span class="titleBar-orb" aria-hidden="true">
          <span class="titleBar-glyph">□</span>
        </span>
      </button>
      <button
        type="button"
        class="titleBar-btn titleBar-btn--close"
        aria-label="关闭"
        @click="handleClose"
      >
        <span class="titleBar-orb" aria-hidden="true">
          <span class="titleBar-glyph">×</span>
        </span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
const isMaximized = ref(false);

async function electronAction(action: string) {
  try {
    const res = await fetch(`tianjiang://${action}`);
    return await res.json();
  } catch {
    // 非 Electron 环境或请求失败
  }
}

function handleMinimize() {
  electronAction("windowMinimize");
}

function handleMaximize() {
  electronAction("windowMaximize");
  isMaximized.value = !isMaximized.value;
}

function handleClose() {
  electronAction("windowClose");
}

async function syncMaximizedState() {
  try {
    const res = await fetch("tianjiang://windowIsMaximized");
    const data = await res.json();
    if (data && typeof data.maximized === "boolean") {
      isMaximized.value = data.maximized;
    }
  } catch {
    // 忽略
  }
}

onMounted(() => {
  syncMaximizedState();
  window.addEventListener("resize", syncMaximizedState);
});

onUnmounted(() => {
  window.removeEventListener("resize", syncMaximizedState);
});
</script>

<style lang="scss" scoped>
.titleBar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--app-titlebar-height, 42px);
  background-color: var(--td-bg-color-secondarycontainer);
  user-select: none;
  -webkit-app-region: drag;
  position: relative;
  z-index: 9999;
  width: 100%;
}

.titleBar-title {
  padding-left: 14px;
  flex: 1;
  overflow: hidden;
}

.titleBar-text {
  font-size: 17px;
  color: var(--td-text-color-primary);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.titleBar-controls {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 10px;
  height: 100%;
  -webkit-app-region: no-drag;
}

.titleBar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  min-width: 32px;
  min-height: 32px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  border-radius: 8px;
  transition: background-color 0.15s, opacity 0.15s;

  &:hover {
    background-color: color-mix(in srgb, var(--td-bg-color-component) 70%, transparent);
  }

  &:active {
    opacity: 0.75;
  }

  &:focus-visible {
    outline: 2px solid var(--td-brand-color);
    outline-offset: 1px;
  }
}

.titleBar-orb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  /* 图标始终可见，不能仅在 hover 时出现 */
}

.titleBar-btn--min .titleBar-orb {
  background: #febc2e;
  color: #5a3b00;
}

.titleBar-btn--max .titleBar-orb {
  background: #28c840;
  color: #0b3d14;
}

.titleBar-btn--close .titleBar-orb {
  background: #ff5f57;
  color: #5a0d09;
}

.titleBar-glyph {
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  transform: translateY(-0.5px);
}
</style>

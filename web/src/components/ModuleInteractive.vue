<template>
  <!--
    统一业务模块悬浮交互外壳：
    - size=sm/default：小卡片 translateY(-2px)+scale(1.02)
    - size=panel：大面板最多 scale(1.01)
    仅包裹可点击/可选择的业务边界；勿包裹 t-input / t-select / 表格行 / 弹层。
  -->
  <component
    :is="tag"
    v-bind="forwardedAttrs"
    :class="rootClass"
    :tabindex="focusable ? 0 : undefined"
  >
    <slot />
  </component>
</template>

<script setup lang="ts">
import { computed, useAttrs } from "vue";

defineOptions({ name: "ModuleInteractive", inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    /** 渲染标签，默认 div */
    tag?: string;
    /** sm：小卡片；panel：大面板 */
    size?: "sm" | "default" | "panel";
    /** 是否可键盘聚焦（可点击卡片建议 true） */
    focusable?: boolean;
    /** 禁用态：不放大 */
    disabled?: boolean;
  }>(),
  {
    tag: "div",
    size: "default",
    focusable: false,
    disabled: false,
  },
);

const attrs = useAttrs();

const rootClass = computed(() => {
  const sizeClass =
    props.size === "panel"
      ? "module-interactive--panel"
      : props.size === "sm"
        ? "module-interactive module-interactive--sm"
        : "module-interactive";
  return [
    sizeClass,
    props.disabled ? "is-disabled" : "",
    attrs.class as string | undefined,
  ].filter(Boolean);
});

const forwardedAttrs = computed(() => {
  const { class: _c, ...rest } = attrs as Record<string, unknown>;
  return rest;
});
</script>

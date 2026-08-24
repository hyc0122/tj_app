<template>
  <t-guide
    v-if="modelValue >= 0"
    :model-value="modelValue"
    :steps="steps"
    @update:model-value="updateVisibleStep">
    <template #content="{ current, total, handlePrev, handleNext }">
      <section class="production-guide-content" data-testid="production-guide-content">
        <!-- 中文注释：真实 TDesign 插槽不提供步骤详情，必须按当前下标读取父级步骤。 -->
        <h3 class="production-guide-title">{{ steps[current]?.title }}</h3>
        <p class="production-guide-body">{{ steps[current]?.body }}</p>
        <footer class="production-guide-footer">
          <span data-testid="production-guide-step">{{ current + 1 }}/{{ total }}</span>
          <div class="production-guide-actions">
            <button
              data-testid="production-guide-close"
              type="button"
              class="production-guide-button production-guide-button--close"
              :disabled="saving"
              @click="requestComplete">
              {{ $t("workbench.production.guideClose") }}
            </button>
            <button
              v-if="current < total - 1"
              data-testid="production-guide-skip"
              type="button"
              class="production-guide-button"
              :disabled="saving"
              @click="requestComplete">
              {{ $t("workbench.production.guideSkip") }}
            </button>
            <button
              v-if="current > 0"
              type="button"
              class="production-guide-button"
              :disabled="saving"
              @click="handlePrev">
              {{ $t("workbench.production.guidePrev") }}
            </button>
            <button
              v-if="current < total - 1"
              type="button"
              class="production-guide-button production-guide-button--primary"
              :disabled="saving"
              @click="handleNext">
              {{ $t("workbench.production.guideNext") }}
            </button>
            <button
              v-else
              data-testid="production-guide-finish"
              type="button"
              class="production-guide-button production-guide-button--primary"
              :disabled="saving"
              @click="requestComplete">
              {{ $t("workbench.production.guideFinish") }}
            </button>
          </div>
        </footer>
      </section>
    </template>
  </t-guide>
</template>

<script setup lang="ts">
import { ref } from "vue";
import type { GuideStep } from "tdesign-vue-next/es/guide/type";

const props = defineProps<{
  modelValue: number;
  steps: GuideStep[];
  complete: () => Promise<boolean>;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: number];
}>();

const saving = ref(false);

function updateVisibleStep(value: number): void {
  // 中文注释：忽略组件内部的提前关闭值；只有持久化成功后控制器才会写入 -1。
  if (Number.isInteger(value) && value >= 0) emit("update:modelValue", value);
}

async function requestComplete(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    // 中文注释：关闭、跳过和完成都等待同一个 App 持久化入口，失败时原位保留按钮供重试。
    await props.complete();
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped lang="scss">
.production-guide-content {
  min-width: 320px;
  max-width: 420px;
  color: var(--td-text-color-primary);
}

.production-guide-title {
  margin: 0 0 8px;
  font-size: 18px;
}

.production-guide-body {
  margin: 0;
  color: var(--td-text-color-secondary);
  line-height: 1.6;
}

.production-guide-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 20px;
}

.production-guide-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.production-guide-button {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--td-component-border);
  border-radius: var(--td-radius-default);
  color: var(--td-text-color-primary);
  background: var(--td-bg-color-container);
  cursor: pointer;

  &:hover:not(:disabled),
  &:focus-visible {
    border-color: var(--td-brand-color);
    color: var(--td-brand-color);
  }

  &:disabled {
    cursor: wait;
    opacity: 0.6;
  }
}

.production-guide-button--close {
  color: var(--td-error-color);
}

.production-guide-button--primary {
  border-color: var(--td-brand-color);
  color: var(--td-text-color-anti);
  background: var(--td-brand-color);
}
</style>

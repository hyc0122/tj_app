<template>
  <div
    v-if="document"
    class="legal-dialog"
    role="dialog"
    aria-modal="true"
    :aria-label="document.title"
    data-testid="legal-document-dialog"
  >
    <div class="legal-dialog__panel">
      <header class="legal-dialog__header">
        <h2 class="legal-dialog__title">{{ document.title }}</h2>
        <button type="button" class="legal-dialog__close" @click="emit('close')">
          {{ $t("common.cancel") }}
        </button>
      </header>
      <p class="legal-dialog__meta">
        {{ $t("login.legal.versionLabel") }}: {{ document.version }}
        ·
        {{ $t("login.legal.updatedAtLabel") }}: {{ document.updatedAt }}
      </p>
      <!-- 纯文本渲染：禁止 v-html，避免后台正文 XSS -->
      <pre class="legal-dialog__body">{{ document.content }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PublicLegalDocument } from "@/features/tianjiang/legal/contracts";

defineProps<{
  document: PublicLegalDocument | null;
}>();

const emit = defineEmits<{
  close: [];
}>();
</script>

<style lang="scss" scoped>
.legal-dialog {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(16, 19, 26, 0.45);
  padding: 24px;
}

.legal-dialog__panel {
  width: min(640px, 100%);
  max-height: min(80vh, 720px);
  display: flex;
  flex-direction: column;
  background: var(--td-bg-color-container);
  border-radius: 16px;
  box-shadow: var(--td-shadow-3);
  padding: 20px 22px;
}

.legal-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.legal-dialog__title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}

.legal-dialog__close {
  border: 0;
  background: transparent;
  color: var(--td-brand-color);
  cursor: pointer;
  font: inherit;
}

.legal-dialog__meta {
  margin: 8px 0 12px;
  font-size: 12px;
  color: var(--td-text-color-secondary);
}

.legal-dialog__body {
  margin: 0;
  flex: 1;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.65;
  color: var(--td-text-color-primary);
}
</style>

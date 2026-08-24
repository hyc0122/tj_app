<template>
  <section v-if="open" data-dialog="storyboard-generation-confirm">
    <t-dialog :visible="open" :header="`确认生成镜头 ${shotNumber}`" @close="emit('close')">
      <div class="generationConfirm">
        <p>
          已取得非收费的服务端最终请求预览。请核对下列模型、提示词与参数后再提交，提交后可能产生费用。
        </p>
        <FinalRequestPreview :request="preview" />
        <p v-if="status" class="generationConfirm__status" role="status">{{ status }}</p>
      </div>
      <template #footer>
        <t-button variant="outline" :disabled="busy" @click="emit('close')">取消</t-button>
        <t-button
          theme="primary"
          data-action="confirm-row-generation"
          :loading="busy"
          :disabled="readonly || busy || !preview"
          @click="emit('confirm')"
        >
          明确确认并生成
        </t-button>
      </template>
    </t-dialog>
  </section>
</template>

<script setup lang="ts">
import type { SafeStoryboardGenerationPreview } from "../storyboard-generation-preview";
import FinalRequestPreview from "./FinalRequestPreview.vue";

defineProps<{
  open: boolean;
  shotNumber: string;
  preview: SafeStoryboardGenerationPreview | null;
  status?: string;
  busy?: boolean;
  readonly?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  confirm: [];
}>();
</script>

<style scoped lang="scss">
.generationConfirm {
  display: grid;
  gap: 14px;
  min-width: min(720px, 80vw);
  color: var(--product-text-secondary);
}

.generationConfirm__status {
  color: var(--td-warning-color);
}

@media (max-width: 760px) {
  .generationConfirm {
    min-width: 0;
  }
}
</style>

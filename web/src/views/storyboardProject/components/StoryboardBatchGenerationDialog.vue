<template>
  <section v-if="open" data-dialog="storyboard-batch-generation">
    <t-dialog :visible="open" header="批量视频生成" @close="emit('close')">
    <section class="batchGeneration">
      <p>本批次将只提交当前筛选结果中的 {{ shotCount }} 个分镜。提交后可能产生费用。</p>
      <StoryboardGenerationSettings
        v-model="draft"
        :readonly="readonly"
        :busy="busy"
        :preferred-provider-model="settings.providerModel"
        @update:catalog-valid="catalogValid = $event"
      />
      <label class="batchGeneration__confirm">
        <input v-model="paidConfirmed" name="paidConfirmed" type="checkbox" :disabled="readonly || busy" />
        <span>我已核对镜头范围，并确认提交可能产生费用</span>
      </label>
      <p v-if="feedback" class="batchGeneration__warning" role="status">{{ feedback }}</p>
      <p v-else-if="previewFeedback" class="batchGeneration__warning" role="status">{{ previewFeedback }}</p>
    </section>
    <template #footer>
      <t-button variant="outline" :disabled="busy" @click="emit('close')">取消</t-button>
      <t-button
        theme="primary"
        data-action="submit-batch-generation"
        :loading="busy"
        :disabled="readonly || !catalogValid || !previewReady"
        @click="submit"
      >确认并提交</t-button>
    </template>
    </t-dialog>
  </section>
</template>

<script setup lang="ts">
import StoryboardGenerationSettings, { type StoryboardGenerationSettingsValue } from "./StoryboardGenerationSettings.vue";

const props = defineProps<{
  open: boolean;
  shotCount: number;
  settings: StoryboardGenerationSettingsValue;
  videoModels?: readonly { value: string; label: string }[];
  readonly?: boolean;
  busy?: boolean;
  previewReady?: boolean;
  previewFeedback?: string;
}>();

const emit = defineEmits<{
  close: [];
  submit: [{ settings: StoryboardGenerationSettingsValue; paidConfirmed: true }];
  "settings-change": [{ settings: StoryboardGenerationSettingsValue }];
}>();

const draft = ref<StoryboardGenerationSettingsValue>({ ...props.settings });
const paidConfirmed = ref(false);
const feedback = ref("");
const catalogValid = ref(false);

watch(() => props.open, (open) => {
  if (!open) return;
  draft.value = { ...props.settings };
  paidConfirmed.value = false;
  feedback.value = "";
  // 中文注释：目录有效性由子组件持续推送；重开不能把仍有效的实时状态人为清空。
});

watch(draft, (value) => {
  if (!props.open) return;
  // 中文注释：非收费预览在用户确认前完成；设置变化立即使父级缓存失效并重新准备。
  emit("settings-change", { settings: { ...value } });
}, { deep: true });

function submit(): void {
  if (props.readonly || props.busy) return;
  if (!paidConfirmed.value) {
    // 中文注释：未明确确认付费时只显示提示，绝不向父级发出提交事件。
    feedback.value = "请先确认本次批量生成可能产生费用";
    return;
  }
  if (!catalogValid.value) {
    // 中文注释：付费确认不能绕过当前账号目录有效性；handler 必须再次失败关闭。
    feedback.value = "当前账号未配置可用视频模型";
    return;
  }
  emit("submit", { settings: { ...draft.value }, paidConfirmed: true });
}
</script>

<style scoped lang="scss">
.batchGeneration {
  display: grid;
  gap: 14px;
  color: var(--product-text);
}

.batchGeneration__confirm {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  color: var(--product-text-secondary);
}

.batchGeneration__confirm:focus-within {
  outline: none;
  box-shadow: var(--product-focus-ring);
}

.batchGeneration__warning {
  color: var(--td-warning-color);
}
</style>

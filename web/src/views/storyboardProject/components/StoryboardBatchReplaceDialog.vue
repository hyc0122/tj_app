<template>
  <section v-if="open" data-dialog="storyboard-batch-replace">
    <t-dialog :visible="open" header="批量文本替换" @close="emit('close')">
      <section class="batchReplace">
        <p data-selected-count>已选择 {{ selectedCount }} 条分镜</p>
        <label class="batchReplace__field">
          <span>查找文本</span>
          <input
            v-model="findText"
            data-field="find-text"
            type="text"
            :maxlength="STORYBOARD_FIND_TEXT_MAX"
            :disabled="busy || readonly"
            placeholder="只替换分镜提示词中的原文"
          />
        </label>
        <label class="batchReplace__field">
          <span>替换为</span>
          <input
            v-model="replaceText"
            data-field="replace-text"
            type="text"
            :maxlength="STORYBOARD_REPLACE_TEXT_MAX"
            :disabled="busy || readonly"
            placeholder="留空表示删除查找内容"
          />
        </label>
        <p>
          预计命中 <strong data-hit-shot-count>{{ hitShotCount }}</strong> 条分镜，
          共替换 <strong data-replacement-count>{{ replacementCount }}</strong> 处。
        </p>
        <p v-if="feedback" class="batchReplace__warning" role="status">{{ feedback }}</p>
      </section>
      <template #footer>
        <t-button variant="outline" :disabled="busy" @click="emit('close')">取消</t-button>
        <t-button
          theme="primary"
          data-action="confirm-batch-replace"
          :loading="busy"
          :disabled="readonly || busy || !canSubmit"
          @click="submit"
        >
          确认替换
        </t-button>
      </template>
    </t-dialog>
  </section>
</template>

<script setup lang="ts">
import { countLiteralOccurrences } from "../storyboard-prompt-replace";
import { STORYBOARD_FIND_TEXT_MAX, STORYBOARD_REPLACE_TEXT_MAX } from "../storyboard-workbench-types";

const props = defineProps<{
  open: boolean;
  selectedCount: number;
  prompts: readonly string[];
  readonly?: boolean;
  busy?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  submit: [{ findText: string; replaceText: string }];
}>();

const findText = ref("");
const replaceText = ref("");

const hitShotCount = computed(() => {
  if (!findText.value) return 0;
  return props.prompts.filter((prompt) => prompt.includes(findText.value)).length;
});

const replacementCount = computed(() => {
  if (!findText.value) return 0;
  return props.prompts.reduce((sum, prompt) => sum + countLiteralOccurrences(prompt, findText.value), 0);
});

const feedback = computed(() => {
  if (!findText.value) return "查找文本不能为空";
  if (findText.value === replaceText.value) return "替换后内容没有变化";
  if (replacementCount.value === 0) return "当前勾选分镜没有可替换内容";
  return "";
});

const canSubmit = computed(() => (
  Boolean(findText.value)
  && findText.value !== replaceText.value
  && replacementCount.value > 0
));

watch(() => props.open, (open) => {
  if (!open) return;
  findText.value = "";
  replaceText.value = "";
});

function submit(): void {
  if (props.readonly || props.busy || !canSubmit.value) return;
  emit("submit", { findText: findText.value, replaceText: replaceText.value });
}
</script>

<style scoped lang="scss">
.batchReplace {
  display: grid;
  gap: 14px;
  color: var(--product-text);
}

.batchReplace__field {
  display: grid;
  gap: 6px;
}

.batchReplace__field input {
  width: 100%;
  min-height: 36px;
  padding: 8px 10px;
  border: 1px solid var(--product-border);
  border-radius: 8px;
  color: inherit;
  background: var(--product-surface-soft);
}

.batchReplace__warning {
  margin: 0;
  color: var(--td-warning-color);
}
</style>

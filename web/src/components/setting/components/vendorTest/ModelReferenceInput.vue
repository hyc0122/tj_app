<template>
  <!-- 账号级测试不借用当前项目上传文件；佳速参考素材按新协议显式填写 HTTPS 地址。 -->
  <t-input v-if="urlOnly" v-model="urlValue" :placeholder="`${label || '参考素材'} HTTPS URL${optional ? '（可选）' : ''}`" clearable />
  <ImageUploadBox v-else-if="kind === 'image'" v-model="fileValue" :label="label" :optional="optional" />
  <VideoUploadBox v-else-if="kind === 'video'" v-model="fileValue" :label="label" />
  <AudioUploadBox v-else v-model="fileValue" :label="label" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import ImageUploadBox from "./ImageUploadBox.vue";
import VideoUploadBox from "./VideoUploadBox.vue";
import AudioUploadBox from "./AudioUploadBox.vue";

const props = defineProps<{
  modelValue?: File | string | null;
  kind: "image" | "video" | "audio";
  urlOnly: boolean;
  label?: string;
  optional?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [value: File | string | null] }>();
const urlValue = computed({
  get: () => typeof props.modelValue === "string" ? props.modelValue : "",
  set: (value: string) => emit("update:modelValue", value.trim() || null),
});
const fileValue = computed({
  get: () => props.modelValue instanceof File ? props.modelValue : null,
  set: (value: File | null) => emit("update:modelValue", value),
});
</script>

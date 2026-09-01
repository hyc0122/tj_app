<template>
  <div v-if="modelValue" class="dialog">
    <input v-model="name" placeholder="画布名称" />
    <select v-model="starter">
      <option v-for="kind in kinds" :key="kind" :value="kind">{{ kind }}</option>
    </select>
    <button type="button" @click="confirm">创建</button>
  </div>
</template>

<script setup lang="ts">
import { CANVAS_STARTER_KINDS, type CanvasStarterKind } from "@/features/tianjiang/canvas/navigation";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  (event: "update:modelValue", value: boolean): void;
  (event: "create", value: { name: string; starter: CanvasStarterKind }): void;
}>();

const kinds = CANVAS_STARTER_KINDS;
const name = ref("未命名画布");
const starter = ref<CanvasStarterKind>("blank");

function confirm(): void {
  emit("create", { name: name.value.trim() || "未命名画布", starter: starter.value });
  emit("update:modelValue", false);
}
</script>

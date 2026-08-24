<template>
  <t-space :size="0">
    <t-button theme="primary" variant="text" :disabled="page.isGenerating(row.id)" @click="page.generate(row)">
      <template #icon><i-magic :size="18" /></template>
      {{ $t("workbench.assets.generate") }}
    </t-button>
    <t-button theme="primary" variant="text" @click="page.handleEdit(row)">
      <template #icon><t-icon name="edit" /></template>
      {{ $t("workbench.assets.edit") }}
    </t-button>
    <t-button theme="danger" variant="text" :disabled="page.isGenerating(row.id)" @click="page.handleDelete(row)">
      <template #icon><t-icon name="delete" /></template>
      {{ $t("workbench.assets.delete") }}
    </t-button>
  </t-space>
</template>

<script setup lang="ts">
import { inject } from "vue";
import type { AssetRecord } from "../composables/assetsLogic";
import { assetsContextKey } from "../composables/assetsContext";

defineProps<{ row: AssetRecord }>();
const page = inject(assetsContextKey)!;
</script>

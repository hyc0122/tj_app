<template>
  <div class="scope-filter-wrap">
    <t-select
      class="scope-filter"
      :value="filter"
      :options="filterOptions"
      :placeholder="$t('projectScope.filterAll')"
      @change="handleChange"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ProjectGroup } from "@/features/tianjiang/project/scope-groups";

const props = defineProps<{
  groups: ProjectGroup[];
  filter: string;
}>();

const emit = defineEmits<{
  "update:filter": [v: string];
}>();

const { t } = useI18n();

const filterOptions = computed(() => {
  const opts = [{ label: t("projectScope.filterAll"), value: "all" }];
  for (const g of props.groups) {
    if (g.key === "personal") {
      opts.push({ label: t("projectScope.personal"), value: "personal" });
    } else if (g.teamUuid) {
      opts.push({
        label: g.titleParams?.name || g.teamUuid,
        value: g.teamUuid,
      });
    }
  }
  return opts;
});

function handleChange(value: unknown): void {
  emit("update:filter", String(value ?? "all"));
}
</script>

<style scoped>
.scope-filter-wrap {
  max-width: 240px;
  margin: 12px 0;
}
</style>

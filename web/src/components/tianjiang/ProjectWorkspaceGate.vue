<template>
  <section class="workspace-gate" :data-project-access-mode="access.mode">
    <t-alert v-if="blocked" theme="warning" class="access-alert">
      {{ blockedText }}
    </t-alert>
    <fieldset :disabled="blocked">
      <slot />
    </fieldset>
  </section>
</template>

<script setup lang="ts">
import projectStore from "@/stores/project";
import { useI18n } from "vue-i18n";

const { access } = storeToRefs(projectStore());
const { t } = useI18n();
const blocked = computed(() => access.value.mode !== "readwrite");
const blockedText = computed(() => access.value.mode === "recovery"
  ? t("projectCatalog.recoveryAvailable")
  : t("projectCatalog.readonly"));
</script>

<style scoped>
.workspace-gate,
.workspace-gate fieldset {
  width: 100%;
  height: 100%;
}
.workspace-gate fieldset {
  padding: 0;
  margin: 0;
  border: 0;
}
.access-alert {
  margin-bottom: 8px;
}
</style>

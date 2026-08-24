<template>
  <div class="scope-selector">
    <t-radio-group :value="scope" :disabled="disabled" variant="default-filled" @change="onScope">
      <t-radio-button value="personal">{{ $t("projectScope.createPersonal") }}</t-radio-button>
      <t-radio-button value="team">{{ $t("projectScope.createTeam") }}</t-radio-button>
    </t-radio-group>
    <t-select
      v-if="scope === 'team'"
      :value="teamUuid"
      :options="teamOptions"
      :placeholder="$t('projectScope.selectTeam')"
      :disabled="disabled || !teamOptions.length"
      class="team-select"
      @change="onTeam"
    />
    <t-alert v-if="!disabled && scope === 'team' && !teamOptions.length" theme="warning">
      {{ $t("projectScope.viewerReadonly") }}
    </t-alert>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { CreatableTeamOption } from "@/features/tianjiang/project/create-project";

const props = defineProps<{
  scope: "personal" | "team";
  teamUuid: string;
  teams: CreatableTeamOption[];
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:scope": [v: "personal" | "team"];
  "update:teamUuid": [v: string];
}>();

const teamOptions = computed(() =>
  props.teams.map((t) => ({ label: `${t.name} (${t.myRole})`, value: t.teamUuid })),
);

function onScope(v: string | number | boolean): void {
  emit("update:scope", v === "team" ? "team" : "personal");
}

function onTeam(v: unknown): void {
  emit("update:teamUuid", String(v ?? ""));
}
</script>

<style scoped>
.scope-selector {
  display: grid;
  gap: 8px;
  margin-bottom: 12px;
}
.team-select {
  max-width: 320px;
}
</style>

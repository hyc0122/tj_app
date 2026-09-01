<template>
  <button type="button" class="card" @click="$emit('open', project.projectUuid)">
    <strong>{{ project.name }}</strong>
  </button>
</template>

<script setup lang="ts">
defineProps<{
  project: { projectUuid: string; name: string };
}>();
defineEmits<{ (event: "open", projectUuid: string): void }>();
</script>

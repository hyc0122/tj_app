<template>
  <CornerScapeWorkspace />
</template>

<script setup lang="ts">
import { provide } from "vue";
import CornerScapeWorkspace from "./components/CornerScapeWorkspace.vue";
import { cornerScapeContextKey } from "./composables/cornerScapeContext";
import { useCornerScapePage } from "./composables/useCornerScapePage";

const page = useCornerScapePage();
provide(cornerScapeContextKey, page);
</script>

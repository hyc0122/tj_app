<template>
  <div class="canvas-node-frame" :data-kind="kind">
    <Handle id="in" type="target" :position="Position.Left" />
    <slot />
    <Handle id="out" type="source" :position="Position.Right" />
  </div>
</template>

<script setup lang="ts">
import { Handle, Position } from "@vue-flow/core";

defineProps<{ kind?: string }>();
</script>

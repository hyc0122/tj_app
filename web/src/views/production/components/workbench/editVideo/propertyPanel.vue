<template>
  <PropertyPanelView />
</template>

<script setup lang="ts">
import { provide } from "vue";
import PropertyPanelView from "./components/PropertyPanelView.vue";
import { propertyPanelContextKey } from "./propertyPanelContext";
import { usePropertyPanel } from "./composables/usePropertyPanel";

provide(propertyPanelContextKey, usePropertyPanel());
</script>

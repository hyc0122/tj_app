<template>
  <div class="addProject">
    <ProjectFormDialog />
    <VisualManualDialog />
    <DirectorManualDialog />
    <t-image-viewer
      v-model="visible"
      :images="[trigger]"
      :close-on-overlay="true"
    />
  </div>
</template>

<script setup lang="ts">
import DirectorManualDialog from "./projectDialog/components/DirectorManualDialog.vue";
import ProjectFormDialog from "./projectDialog/components/ProjectFormDialog.vue";
import VisualManualDialog from "./projectDialog/components/VisualManualDialog.vue";
import {
  createProjectDialogContext,
  provideProjectDialogContext,
} from "./projectDialog/projectDialogContext";
import type { ProjectData, ProjectEditPayload } from "./projectDialog/types";

const addProjectShow = defineModel<boolean>();
const props = defineProps<{
  projectData?: ProjectData | null;
  saveEdit?: (data: ProjectEditPayload) => Promise<void>;
}>();
const emit = defineEmits<{
  (
    event: "add",
    data: {
      projectType: string;
      name: string;
      intro: string;
      type: string;
      artStyle: string;
      directorManual: string;
      videoRatio: string;
      imageModel: string;
      videoModel: string;
      imageQuality: "1K" | "2K" | "4K" | "";
      mode: string;
      scope: "personal" | "team";
      teamUuid: string;
    },
  ): void;
  (
    event: "edit",
    data: ProjectEditPayload,
  ): void;
  (event: "created"): void;
}>();

// 主文件只维持原有 v-model、props、emits，并组装三个弹窗区块。
const context = createProjectDialogContext({
  addProjectShow,
  props,
  emit,
});
provideProjectDialogContext(context);
const { trigger, visible } = context;
</script>

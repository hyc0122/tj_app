import type { InjectionKey, Ref } from "vue";
import type { ToolbarNames } from "md-editor-v3";
import settingStore from "@/stores/setting";
import type { ProjectData, ProjectEditPayload, ProjectFormData } from "./types";
import { promptToolbars } from "./projectDialogLogic";
import { useDirectorManual } from "./useDirectorManual";
import { useProjectForm } from "./useProjectForm";
import { useVisualManual } from "./useVisualManual";

type ProjectDialogEmit = {
  (
    event: "add",
    data: Omit<ProjectFormData, "id" | "era" | "createTime" | "userId">,
  ): void;
  (
    event: "edit",
    data: Omit<ProjectFormData, "era" | "createTime" | "userId"> & {
      id: string;
    },
  ): void;
  (event: "created"): void;
};

export function createProjectDialogContext(options: {
  addProjectShow: Ref<boolean | undefined>;
  props: {
    projectData?: ProjectData | null;
    saveEdit?: (data: ProjectEditPayload) => Promise<void>;
  };
  emit: ProjectDialogEmit;
}) {
  const { themeSetting } = storeToRefs(settingStore());
  const loading = ref(false);
  const trigger = ref("");
  const visible = ref(false);
  const visualManual = useVisualManual(loading);
  const directorManual = useDirectorManual(loading);
  const projectForm = useProjectForm(
    options.addProjectShow,
    options.props,
    options.emit,
    {
      fetchVisualManuals: visualManual.fetchVisualManuals,
      queryDirectorManual: directorManual.queryDirectorManual,
    },
  );

  return {
    ...directorManual,
    ...projectForm,
    ...visualManual,
    handlePreview: (source?: string) => {
      visible.value = true;
      trigger.value = source ?? "";
    },
    loading,
    promptToolbars: [...promptToolbars] as ToolbarNames[],
    themeSetting,
    trigger,
    visible,
  };
}

export type ProjectDialogContext = ReturnType<
  typeof createProjectDialogContext
>;

export const projectDialogKey: InjectionKey<ProjectDialogContext> =
  Symbol("project-dialog");

export function provideProjectDialogContext(context: ProjectDialogContext) {
  provide(projectDialogKey, context);
}

export function useProjectDialogContext() {
  const context = inject(projectDialogKey);
  if (!context) {
    throw new Error($t("workbench.project.msg.operationFailed"));
  }
  return context;
}

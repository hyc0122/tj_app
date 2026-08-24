import axios from "@/utils/axios";
import type { Ref } from "vue";
import type { ProjectData, ProjectEditPayload, ProjectFormData, VideoMode } from "./types";
import {
  createProjectForm,
  createProjectModeLabels,
  findMissingProjectField,
  getModeLabel,
  modeToKey,
  RATIO_OPTIONS,
} from "./projectDialogLogic";
import {
  createProjectWithLocalInit,
  LocalProjectInitError,
  normalizeProjectOperationError,
  type FullProjectCreateFields,
} from "@/features/tianjiang/project/create-project-flow";
import {
  filterCreatableTeams,
  projectCapabilities,
  type CreatableTeamOption,
} from "@/features/tianjiang/project/create-project";
import { fetchProjectCatalog, type CatalogProject } from "@/features/tianjiang/project/catalog";
import { listTeams } from "@/features/tianjiang/team/client";
import Router from "@/router/index";
import { currentAccountScopeId, modelCatalogStore } from "@/features/models/modelCatalogStore";

type ProjectEmit = {
  (event: "add", data: Omit<ProjectFormData, "id" | "era" | "createTime" | "userId">): void;
  (
    event: "edit",
    data: Omit<ProjectFormData, "era" | "createTime" | "userId"> & { id: string },
  ): void;
  (event: "created"): void;
};

const missingMessageMap = {
  name: "workbench.project.msg.enterProjectName",
  type: "workbench.project.msg.enterProjectType",
  imageModel: "workbench.project.msg.enterImageModel",
  videoModel: "workbench.project.msg.enterVideoModel",
  artStyle: "workbench.project.msg.enterArtStyle",
  directorManual: "workbench.project.msg.directorManual",
  videoRatio: "workbench.project.msg.enterVideoRatio",
  intro: "workbench.project.msg.enterProjectIntro",
  imageQuality: "workbench.project.msg.enterProjectQuality",
  mode: "workbench.project.msg.selectMode",
  defaultLanguage: "workbench.project.dialog.defaultLanguagePh",
  assetSourceProjectUuid: "workbench.project.dialog.assetSourcePh",
} as const;

export function useProjectForm(
  addProjectShow: Ref<boolean | undefined>,
  props: {
    projectData?: ProjectData | null;
    saveEdit?: (data: ProjectEditPayload) => Promise<void>;
  },
  emit: ProjectEmit,
  loadManuals: {
    fetchVisualManuals: () => void;
    queryDirectorManual: () => void;
  },
) {
  const formState = ref(createProjectForm(props.projectData));
  const mode = ref<{ label: string; value: string }[]>([]);
  const isEdit = computed(() => Boolean(props.projectData));
  const creatableTeams = ref<CreatableTeamOption[]>([]);
  const sourceProjects = ref<CatalogProject[]>([]);
  /** 中央已成功时保留 UUID，重试只跑本地初始化。 */
  const pendingProjectUuid = ref<string>("");
  const submitting = ref(false);

  const modeLabels = createProjectModeLabels($t);

  function resetForm() {
    formState.value = createProjectForm();
    pendingProjectUuid.value = "";
  }

  function handleCancel() {
    addProjectShow.value = false;
    resetForm();
  }

  function toFields(): FullProjectCreateFields {
    return {
      projectType: formState.value.projectType || "novel",
      name: formState.value.name,
      intro: formState.value.intro,
      type: formState.value.type,
      artStyle: formState.value.artStyle,
      videoRatio: formState.value.videoRatio || "16:9",
      imageModel: formState.value.imageModel,
      videoModel: formState.value.videoModel,
      imageQuality: formState.value.imageQuality,
      directorManual: formState.value.directorManual,
      mode: formState.value.mode,
      scope: formState.value.scope,
      teamUuid: formState.value.teamUuid,
      defaultLanguage: formState.value.defaultLanguage,
      assetSourceProjectUuid: formState.value.assetMode === "shared"
        ? formState.value.assetSourceProjectUuid
        : "",
    };
  }

  async function handleOk() {
    // confirm-loading 渲染前仍可能收到连续点击，必须在业务入口同步去重。
    if (submitting.value) return;
    const missing = findMissingProjectField(formState.value);
    if (missing) {
      window.$message.warning($t(missingMessageMap[missing]));
      return;
    }
    if (isEdit.value) {
      const fields = toFields();
      // 编辑同样发送数字 id，与 editProject 正安全整数契约一致。
      const numericId = Number(formState.value.id);
      if (!Number.isSafeInteger(numericId) || numericId <= 0) {
        window.$message.error($t("workbench.project.msg.editFailed"));
        return;
      }
      const payload = {
        id: String(numericId),
        projectType: fields.projectType,
        name: fields.name,
        intro: fields.intro,
        type: fields.type,
        artStyle: fields.artStyle,
        directorManual: fields.directorManual,
        videoRatio: fields.videoRatio,
        imageModel: fields.imageModel,
        videoModel: fields.videoModel,
        imageQuality: formState.value.imageQuality,
        mode: fields.mode,
        scope: formState.value.scope,
        teamUuid: formState.value.teamUuid,
        defaultLanguage: formState.value.defaultLanguage,
        assetMode: formState.value.assetMode,
        assetSourceProjectUuid: formState.value.assetSourceProjectUuid,
      };
      submitting.value = true;
      try {
        if (props.saveEdit) {
          await props.saveEdit(payload);
        } else {
          emit("edit", payload);
        }
        resetForm();
        addProjectShow.value = false;
      } catch (error) {
        // 保存链任一步失败都保留表单，用户可在原处重试。
        window.$message.error(normalizeProjectOperationError(
          error,
          $t("workbench.project.msg.editFailed"),
        ));
      } finally {
        submitting.value = false;
      }
      return;
    }
    if (formState.value.scope === "team" && !String(formState.value.teamUuid || "").trim()) {
      window.$message.warning($t("projectScope.selectTeam"));
      return;
    }

    submitting.value = true;
    try {
      const fields = toFields();
      const { opened } = await createProjectWithLocalInit(
        fields,
        pendingProjectUuid.value || undefined,
      );
      pendingProjectUuid.value = "";
      const capabilities = projectCapabilities(fields.projectType);
      resetForm();
      addProjectShow.value = false;
      emit("created");
      await Router.push(capabilities.route);
    } catch (error) {
      if (error instanceof LocalProjectInitError) {
        // 中央已成功：表单保留，仅记录 UUID 供重试。
        pendingProjectUuid.value = error.projectUuid;
      }
      window.$message.error(normalizeProjectOperationError(
        error,
        $t("workbench.project.msg.addFailed"),
      ));
    } finally {
      submitting.value = false;
    }
  }

  function toModeOption(item: VideoMode) {
    return {
      label: getModeLabel(item, modeLabels),
      value: modeToKey(item),
    };
  }

  function changeFn(_value: string, data: { mode: VideoMode[] }) {
    mode.value = data.mode.map(toModeOption);
  }

  async function loadEditingVideoModes(project: ProjectData) {
    if (!project.videoModel) return;
    try {
      const { data } = await axios.post("/modelSelect/getModelDetail", {
        modelId: project.videoModel,
      });
      if (data?.mode) mode.value = data.mode.map(toModeOption);
    } catch {
      // 模型详情读取失败不阻断项目其他字段回显。
    }
  }

  async function loadCreatableTeams() {
    try {
      const teams = await listTeams();
      creatableTeams.value = filterCreatableTeams(teams as any);
    } catch {
      creatableTeams.value = [];
    }
  }

  async function loadSourceProjects() {
    try {
      sourceProjects.value = await fetchProjectCatalog();
    } catch {
      sourceProjects.value = [];
    }
  }

  async function preloadModelCatalogs() {
    // 中文注释：图片/视频目录并行预热账号缓存，不得串行等待即梦探测。
    const accountScopeId = currentAccountScopeId();
    const keptImage = formState.value.imageModel;
    const keptVideo = formState.value.videoModel;
    try {
      await Promise.all([
        modelCatalogStore.ensure(accountScopeId, "image"),
        modelCatalogStore.ensure(accountScopeId, "video"),
      ]);
    } catch {
      // 目录刷新失败时仍保留已有默认模型，由下拉展示校准状态。
    }
    if (keptImage) formState.value.imageModel = keptImage;
    if (keptVideo) formState.value.videoModel = keptVideo;
  }

  watch(addProjectShow, async (visible) => {
    if (!visible) return;
    if (props.projectData) {
      formState.value = createProjectForm(props.projectData);
      pendingProjectUuid.value = "";
      await loadCreatableTeams();
      if (
        props.projectData.kind === "team" &&
        props.projectData.teamUuid &&
        !creatableTeams.value.some((team) => team.teamUuid === props.projectData?.teamUuid)
      ) {
        // 编辑态归属只展示；即使当前团队已不可创建，也必须保留真实名称。
        creatableTeams.value.push({
          teamUuid: props.projectData.teamUuid,
          name: props.projectData.teamName || props.projectData.teamUuid,
          myRole: "editor",
        });
      }
      await loadEditingVideoModes(props.projectData);
    } else {
      // 新建：若上次中央已成功，保留表单与 pending UUID 供重试。
      if (!pendingProjectUuid.value) {
        resetForm();
      }
      await loadCreatableTeams();
    }
    await Promise.all([
      loadSourceProjects(),
      preloadModelCatalogs(),
    ]);
    loadManuals.fetchVisualManuals();
    loadManuals.queryDirectorManual();
  }, { immediate: true });

  return {
    RATIO_OPTIONS,
    addProjectShow,
    changeFn,
    formState,
    handleCancel,
    handleOk,
    isEdit,
    mode,
    creatableTeams,
    sourceProjects,
    submitting,
    pendingProjectUuid,
  };
}

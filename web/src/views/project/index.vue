<template>
  <div class="project">
    <centralCatalog ref="centralCatalogRef" @create="openCreateProject" @edit="openCatalogEdit" />
    <!-- 仅在仍有本地遗留项目时展示完整入口，中央目录始终保留。 -->
    <template v-if="allProject.length > 0">
      <div class="header">
        <div class="fc">
          <span class="title">{{ $t("workbench.project.title") }}</span>
          <span class="sub">{{ $t("workbench.project.subtitle") }}</span>
        </div>
        <t-button
          class="addBtn"
          @click="openCreateProject">
          <template #icon><i-plus class="addIcon" :size="20" /></template>
          {{ $t("workbench.project.newProject") }}
        </t-button>
      </div>
      <div class="list">
        <t-card hoverShadow class="card module-interactive" v-for="project in allProject" :key="project.id" @click="openProject(project.id)" tabindex="0" @keydown.enter.prevent="openProject(project.id)">
          <div class="jb ac">
            <div class="title">
              {{ project.name }}
            </div>
            <div>
              <t-tag shape="round">
                {{
                  project.projectType === "storyboard"
                    ? $t("workbench.project.type.storyboard")
                    : project.projectType === "script"
                      ? $t("workbench.project.type.script")
                      : $t("workbench.project.type.novel")
                }}
              </t-tag>
            </div>
          </div>
          <t-tag shape="round" v-if="project.artStyle" style="align-self: flex-start">{{ project.artStyle }}</t-tag>
          <div class="intro">
            {{ project.intro }}
          </div>
          <div class="bottomMenu f ac jb">
            <div class="time">
              <span>{{ dayjs(project?.createTime).format("YYYY-MM-DD HH:mm:ss") }}</span>
            </div>
            <div class="actionBtns f ac">
              <div class="editBtn" @click.stop="openEdit(project)">
                <i-edit :size="18" />
              </div>
              <div class="removeBtn" @click.stop="delProjcer(project.id)">
                <i-delete :size="18" />
              </div>
            </div>
          </div>
        </t-card>
      </div>
    </template>
  </div>
  <projectDialog
    v-model="dialogShow"
    :projectData="editProjectData"
    :save-edit="editProjectFn"
    @edit="editProjectFn"
    @created="onProjectCreated"
  />
</template>

<script setup lang="ts">
import projectDialog from "./components/projectDialog.vue";
import centralCatalog from "./components/centralCatalog.vue";
import dayjs from "dayjs";
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import imageListCacheStore from "@/stores/imageListCache";
import { projectCapabilities } from "@/features/tianjiang/project/create-project";
import { openCatalogProject, type CatalogProject } from "@/features/tianjiang/project/catalog";
import { saveFullCatalogProject } from "@/features/tianjiang/project/project-actions";
import type { FullProjectCreateFields } from "@/features/tianjiang/project/create-project-flow";
import type { ProjectData } from "./components/projectDialog/types";

const { clearProjectCache } = imageListCacheStore();
const store = projectStore();
const { allProject, project, access } = storeToRefs(store);

const dialogShow = ref(false);
const centralCatalogRef = ref<{ refresh?: () => void } | null>(null);
const catalogUnreachable = ref(false);
const editProjectData = ref<ProjectData | null>(null);
/** 云端编辑上下文用于区分中央元数据保存与本地遗留编辑。 */
const catalogEditContext = ref<CatalogProject | null>(null);

async function getAllProject() {
  try {
    const { data } = await axios.post("/project/getProject");
    const rows = Array.isArray(data) ? data : [];
    // 已关联中央 UUID / tombstone 的项目不得出现在「我的项目」。
    const mapped = rows.map((item: Record<string, unknown>) => ({
      ...item,
      id: item.id == null ? "" : String(item.id),
      projectUuid: typeof item.projectUuid === "string" ? item.projectUuid : undefined,
    })) as import("@/stores/project").Project[];
    allProject.value = store.filterVisibleLocalProjects(mapped);
    catalogUnreachable.value = false;
  } catch (error: any) {
    // 中央/网络未知时不得擅自清空本地列表；标记待确认并保留 tombstone 过滤后的缓存。
    catalogUnreachable.value = true;
    allProject.value = store.filterVisibleLocalProjects(allProject.value).map((item) => ({
      ...item,
      localOnlyPending: true,
    }));
    const msg =
      typeof error?.message === "string" && error.message !== "[object Object]"
        ? error.message
        : $t("workbench.project.msg.loadFailed");
    // 预期的「项目或子资源不存在」在首页不应反复刷屏（账号级列表已绕过该门）。
    if (!/项目或子资源不存在/.test(msg)) {
      window.$message.error(msg);
    }
  }
}

onMounted(() => {
  // workbench 路由侦听负责 close+clear；此处只刷新本地遗留列表并过滤 tombstone。
  allProject.value = store.filterVisibleLocalProjects(allProject.value);
  void getAllProject();
});

const router = useRouter();

/** 完整创建表单：含 scope/teamUuid 与本地字段，创建流水线在弹窗内执行。 */
function openCreateProject(): void {
  catalogEditContext.value = null;
  editProjectData.value = null;
  dialogShow.value = true;
}

/**
 * 云端目录只有摘要字段。必须先走生产 open 链路取得本地数字 ID，再从 project.sqlite
 * 读取完整表单，禁止用空字段覆盖用户配置。
 */
async function openCatalogEdit(item: CatalogProject): Promise<void> {
  try {
    const opened = await openCatalogProject(item.projectUuid);
    store.activateProject(opened.project, {
      projectUuid: opened.projectUuid,
      mode: opened.accessMode,
      reason: opened.readonlyReason ?? "",
      lockHolder: opened.lockHolder ?? "",
      runtimeGeneration: opened.runtimeGeneration,
    });
    if (opened.accessMode !== "readwrite") {
      window.$message.warning($t("projectCatalog.readonly"));
      return;
    }
    const localId = Number(opened.project.id);
    if (!Number.isSafeInteger(localId) || localId <= 0) {
      throw new Error($t("workbench.project.msg.notFound"));
    }
    const response = await axios.post("/general/getSingleProject", { id: localId });
    const row = Array.isArray(response.data) ? response.data[0] : undefined;
    if (!row) throw new Error($t("workbench.project.msg.notFound"));
    catalogEditContext.value = item;
    editProjectData.value = {
      ...row,
      id: String(row.id),
      projectUuid: item.projectUuid,
      kind: item.kind,
      teamUuid: item.teamUuid || "",
      teamName: item.teamName,
      accessMode: opened.accessMode,
      projectType: row.projectType || item.businessType,
      defaultLanguage: row.defaultLanguage || item.defaultLanguage,
      assetSourceProjectUuid: item.assetSourceProjectUuid,
    };
    dialogShow.value = true;
  } catch (error: any) {
    window.$message.error(error?.message || $t("projectCatalog.error.open"));
  }
}

function onProjectCreated(): void {
  void getAllProject();
  centralCatalogRef.value?.refresh?.();
}

async function openProject(projectId: string | undefined) {
  const item = allProject.value.find((p) => p.id === projectId);

  if (!item) return window.$message.error($t("workbench.project.msg.notFound"));

  if (!item.imageModel || !item.videoModel) {
    window.$message.warning($t("workbench.project.msg.modelProviderDisabled"));
    return openEdit(item);
  }

  try {
    if (item.imageModel) {
      await axios.post("/modelSelect/getModelDetail", {
        modelId: item.imageModel,
      });
    }
    if (item.videoModel) {
      await axios.post("/modelSelect/getModelDetail", {
        modelId: item.videoModel,
      });
    }
  } catch {
    window.$message.warning($t("workbench.project.msg.modelProviderDisabled"));
    return openEdit(item);
  }

  // 中文注释：所有入口统一走激活器，确保旧项目运行态在切换前被销毁。
  store.activateProject(item, {
    mode: "readwrite",
    reason: "legacy_local",
    lockHolder: "",
  });
  try {
    router.push(projectCapabilities(item.projectType).route);
  } catch {
    window.$message.warning($t("workbench.project.msg.notFound"));
  }
}

function openEdit(item: {
  id: string;
  name: string;
  intro: string;
  type: string;
  artStyle: string | null;
  directorManual: string;
  videoRatio: string | null;
  imageModel: string;
  videoModel: string;
  imageQuality: "1K" | "2K" | "4K" | "";
  projectType: string;
  mode: string;
}) {
  catalogEditContext.value = null;
  editProjectData.value = {
    ...item,
    projectUuid: "",
    kind: "personal",
    teamUuid: "",
    accessMode: "readwrite",
  };
  dialogShow.value = true;
}

async function editProjectFn(data: {
  id: string;
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
}): Promise<void> {
  // editProject 契约要求 id 为正安全整数（JSON number）。
  const id = Number(data.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error($t("workbench.project.msg.editFailed"));
  }
  if (catalogEditContext.value) {
    await saveFullCatalogProject(
      catalogEditContext.value.projectUuid,
      id,
      data as FullProjectCreateFields,
    );
    centralCatalogRef.value?.refresh?.();
    catalogEditContext.value = null;
  } else {
    await axios.post("/project/editProject", { ...data, id });
  }
  window.$message.success($t("workbench.project.msg.editSuccess"));
  await getAllProject();
}

function delProjcer(projectId: string | number | undefined) {
  // 本地遗留项目删除必须发送正安全整数 ID。
  const id = Number(projectId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    window.$message.error($t("workbench.project.msg.deleteFailed"));
    return;
  }
  const dialog = DialogPlugin.confirm({
    header: $t("workbench.project.msg.deleteHeader"),
    body: $t("workbench.project.msg.deleteBody"),
    confirmBtn: $t("workbench.project.msg.deleteConfirm"),
    cancelBtn: $t("workbench.project.msg.deleteCancel"),
    onConfirm: () => {
      axios
        .post("/project/delProject", { id })
        .then(() => {
          clearProjectCache(String(id));
          window.$message.success($t("workbench.project.msg.deleteSuccess"));
          getAllProject();
        })
        .catch((e) => {
          const msg =
            typeof e?.message === "string" && e.message !== "[object Object]"
              ? e.message
              : $t("workbench.project.msg.deleteFailed");
          window.$message.error(msg);
        })
        .finally(() => {
          dialog.destroy();
        });
    },
  });
}
</script>

<style lang="scss" scoped>
.project {
  .header {
    padding-top: 32px;
    margin-bottom: 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    .title {
      font-size: 32px;
      font-weight: 600;
      color: var(--td-text-color-primary);
    }
    .sub {
      opacity: 0.5;
      color: var(--td-text-color-secondary);
    }
  }
  .list {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    .card {
      width: 100%;
      height: 100%;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      .title {
        font-size: 20px;
        font-weight: bold;
        margin-bottom: 8px;
      }
      .intro {
        height: 100%;
        margin-top: 5px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .bottomMenu {
        margin-top: 32px;
        .time {
          opacity: 0.5;
        }
        .actionBtns {
          gap: 12px;
        }
        .editBtn {
          cursor: pointer;
          &:hover {
            color: var(--td-brand-color);
          }
        }
        .removeBtn {
          cursor: pointer;
          &:hover {
            color: red;
          }
        }
      }
    }
  }
}
:deep(.t-col) {
  height: auto !important;
}
:deep(.t-card__body) {
  display: flex;
  flex-direction: column;
  flex: 1;
}
</style>

<template>
  <section class="catalog">
    <div class="catalog-title">
      <div>
        <strong>{{ $t("projectCatalog.title") }}</strong>
        <span>{{ $t("projectCatalog.lazyHint") }}</span>
      </div>
      <div class="title-actions">
        <t-button size="small" @click="emit('create')">{{ $t("workbench.project.newProject") }}</t-button>
        <t-button variant="text" :loading="loading" @click="refresh">{{ $t("projectCatalog.refresh") }}</t-button>
      </div>
    </div>

    <t-alert v-if="recoveryPrompt" theme="warning" class="recovery-alert">
      <span>{{ $t("projectCatalog.recoveryAvailable") }}</span>
      <t-button size="small" variant="outline" @click="continueRecoveryOpen">
        {{ $t("projectCatalog.recoveryAction") }}
      </t-button>
    </t-alert>

    <ProjectCatalogGroups
      v-if="groups.length"
      :groups="groups"
      :filter="scopeFilter"
      @update:filter="scopeFilter = $event"
    />

    <div v-if="visibleGroups.length" class="card-grid">
      <section v-for="group in visibleGroups" :key="group.key" class="group">
        <h3>
          {{
            group.key === "personal"
              ? $t("projectScope.personal")
              : $t("projectScope.team") + " · " + (group.titleParams?.name || "")
          }}
        </h3>
        <div class="cards">
          <article
            v-for="item in group.items"
            :key="item.projectUuid"
            class="project-card module-interactive"
            data-testid="cloud-project-card"
            tabindex="0"
          >
            <div class="card-head">
              <strong class="card-name">{{ item.name }}</strong>
              <div class="tags">
                <t-tag size="small" :theme="item.kind === 'team' ? 'warning' : 'primary'">
                  {{ $t(`projectCatalog.kind.${item.kind}`) }}
                </t-tag>
                <t-tag v-if="item.teamName" size="small">{{ item.teamName }}</t-tag>
                <t-tag size="small">{{ $t(`projectCatalog.role.${item.myRole}`) }}</t-tag>
                <t-tag size="small">
                  {{
                    item.businessType === "storyboard"
                      ? $t("workbench.project.type.storyboard")
                      : item.businessType === "script"
                        ? $t("workbench.project.type.script")
                        : $t("workbench.project.type.novel")
                  }}
                </t-tag>
              </div>
            </div>
            <div class="card-meta">
              {{ $t("projectCatalog.version", { version: item.currentVersion }) }}
              · {{ $t(`projectCatalog.sync.${item.syncState}`) }}
              · {{ $t(`projectCatalog.mode.${item.openMode}`) }}
              · {{ lockText(item) }}
              · {{ formatTime(String(item.updatedAt || "")) }}
            </div>
            <div class="card-actions">
              <t-button
                size="small"
                :loading="openingProjectUuid === item.projectUuid"
                @click="handleOpenByUuid(item.projectUuid)"
              >
                {{
                  String(item.openMode) === "readonly" || item.myRole === "viewer"
                    ? $t("projectCatalog.openReadonly")
                    : $t("projectCatalog.open")
                }}
              </t-button>
              <t-button
                v-if="canEditCatalogProject(asCatalog(item))"
                size="small"
                variant="outline"
                @click="openEdit(asCatalog(item))"
              >
                {{ $t("projectCatalog.edit") }}
              </t-button>
              <t-tooltip
                v-if="shouldShowDeleteCatalogEntry(asCatalog(item))"
                :content="
                  canDeleteCatalogProject(asCatalog(item))
                    ? ''
                    : catalogDeleteDisabledReason(asCatalog(item)) ||
                      $t('projectCatalog.deleteOwnerOnly')
                "
                :disabled="canDeleteCatalogProject(asCatalog(item))"
              >
                <t-button
                  size="small"
                  theme="danger"
                  variant="outline"
                  :disabled="!canDeleteCatalogProject(asCatalog(item))"
                  :loading="deletingUuid === item.projectUuid"
                  @click="
                    canDeleteCatalogProject(asCatalog(item)) &&
                      confirmDelete(asCatalog(item))
                  "
                >
                  {{ $t("projectCatalog.delete") }}
                </t-button>
              </t-tooltip>
            </div>
          </article>
        </div>
      </section>
    </div>
    <t-empty v-else :description="$t('projectCatalog.empty')" />

  </section>
</template>

<script setup lang="ts">
import dayjs from "dayjs";
import { computed, onMounted, ref } from "vue";
import { DialogPlugin, MessagePlugin } from "tdesign-vue-next";
import { projectCapabilities } from "@/features/tianjiang/project/create-project";
import Router from "@/router/index";
import {
  fetchProjectCatalog,
  openCatalogProject,
  refreshRuntimeProjectCatalog,
  type CatalogProject,
} from "@/features/tianjiang/project/catalog";
import {
  canDeleteCatalogProject,
  canEditCatalogProject,
  catalogDeleteDisabledReason,
  deleteCatalogProject,
  safeProjectActionMessage,
  shouldShowDeleteCatalogEntry,
} from "@/features/tianjiang/project/project-actions";
import {
  filterGroupsByScope,
  groupProjectsByScope,
  type ScopedCatalogItem,
} from "@/features/tianjiang/project/scope-groups";
import ProjectCatalogGroups from "./ProjectCatalogGroups.vue";
import projectStore from "@/stores/project";
import { useI18n } from "vue-i18n";

const emit = defineEmits<{ create: []; edit: [item: CatalogProject] }>();
const loading = ref(false);
const openingProjectUuid = ref("");
const deletingUuid = ref("");
const projects = ref<CatalogProject[]>([]);
const scopeFilter = ref("all");
const recoveryPrompt = ref<{
  item: CatalogProject;
  openMode: "editable" | "readonly";
} | null>(null);
const { t } = useI18n();
const activeProjectStore = projectStore();
const groups = computed(() => groupProjectsByScope(projects.value).groups);
const visibleGroups = computed(() => filterGroupsByScope(groups.value, scopeFilter.value));

function formatTime(value: string): string {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : t("projectCatalog.notUpdated");
}

/** 分组项补齐 CatalogProject 必需字段，供权限与编辑使用。 */
function asCatalog(item: ScopedCatalogItem): CatalogProject {
  return {
    projectUuid: item.projectUuid,
    name: item.name,
    kind: item.kind,
    teamUuid: item.teamUuid,
    teamName: item.teamName,
    myRole: (item.myRole as CatalogProject["myRole"]) || "viewer",
    currentVersion: Number(item.currentVersion ?? 0),
    syncState: String(item.syncState ?? "synced"),
    lastSyncedAt: item.lastSyncedAt ?? null,
    updatedAt: String(item.updatedAt ?? ""),
    lockStatus: (item.lockStatus as CatalogProject["lockStatus"]) || "none",
    lockHolderName: item.lockHolderName || "",
    openMode: (item.openMode as CatalogProject["openMode"]) || "readonly",
    businessType: item.businessType === "script" || item.businessType === "storyboard"
      ? item.businessType
      : "novel",
    assetSourceProjectUuid: item.assetSourceProjectUuid,
  };
}

function lockText(item: ScopedCatalogItem): string {
  if (item.kind === "personal" || !item.lockStatus || item.lockStatus === "none") {
    return t("projectCatalog.lock.none");
  }
  if (item.lockHolderName) {
    return t("projectCatalog.lock.heldBy", { name: item.lockHolderName });
  }
  return t(`projectCatalog.lock.${item.lockStatus}`);
}

function openErrorMessage(error: any): string {
  const code = error?.code ?? error?.response?.data?.code;
  const key = ({
    INSUFFICIENT_DISK_SPACE: "projectCatalog.error.disk",
    SQLITE_INTEGRITY_FAILED: "projectCatalog.error.integrity",
    BASE_VERSION_STALE: "projectCatalog.error.conflict",
    STORAGE_UNAVAILABLE: "projectCatalog.error.storage",
  } as Record<string, string>)[code];
  return key
    ? t(key)
    : safeProjectActionMessage(error, t("projectCatalog.error.open"));
}

async function handleOpen(item: CatalogProject): Promise<void> {
  openingProjectUuid.value = item.projectUuid;
  try {
    const opened = await openCatalogProject(item.projectUuid);
    const openMode = opened.editable ? "editable" : "readonly";
    activeProjectStore.activateProject(opened.project, {
      projectUuid: opened.projectUuid,
      mode: opened.accessMode,
      reason: opened.readonlyReason ?? "",
      lockHolder: opened.lockHolder ?? "",
    });
    if (openMode === "readonly" || item.myRole === "viewer") {
      MessagePlugin.warning(
        opened.lockHolder
          ? t("projectCatalog.readonlyHeld", { name: opened.lockHolder })
          : t("projectCatalog.readonly"),
      );
    }
    if (opened.recoveryRequired) {
      recoveryPrompt.value = { item, openMode };
      return;
    }
    await enterWorkspace(false);
  } catch (error) {
    MessagePlugin.error(openErrorMessage(error));
  } finally {
    openingProjectUuid.value = "";
  }
}

function handleOpenByUuid(projectUuid: string): void {
  const found = projects.value.find((p) => p.projectUuid === projectUuid);
  if (found) void handleOpen(found);
}

async function enterWorkspace(recoveryRequired: boolean): Promise<void> {
  const openedProject = activeProjectStore.project;
  if (!openedProject) {
    throw new Error(t("projectCatalog.error.open"));
  }
  let route = "/project";
  try {
    route = projectCapabilities(openedProject.projectType).route;
  } catch {
    throw new Error(t("projectCatalog.error.open"));
  }
  await Router.push({
    path: recoveryRequired ? "/project-recovery" : route,
  });
}

async function continueRecoveryOpen(): Promise<void> {
  if (!recoveryPrompt.value) return;
  recoveryPrompt.value = null;
  await enterWorkspace(true);
}

function openEdit(item: CatalogProject): void {
  // 目录只携带摘要字段；完整编辑必须由父页面打开项目后读取 project.sqlite。
  emit("edit", item);
}

function confirmDelete(item: CatalogProject): void {
  const dialog = DialogPlugin.confirm({
    theme: "danger",
    header: t("projectCatalog.deleteHeader"),
    body: t("projectCatalog.deleteBodySchemeB"),
    confirmBtn: { content: t("projectCatalog.deleteConfirm"), theme: "danger" },
    cancelBtn: t("projectCatalog.deleteCancel"),
    onConfirm: async () => {
      deletingUuid.value = item.projectUuid;
      try {
        const result = await deleteCatalogProject(item.projectUuid);
        projects.value = projects.value.filter((row) => row.projectUuid !== item.projectUuid);
        if (result.cleanupPending) {
          MessagePlugin.warning(t("projectCatalog.deleteLocalPending"));
        } else {
          MessagePlugin.success(t("projectCatalog.deleteSuccess"));
        }
      } catch (error) {
        MessagePlugin.error(
          safeProjectActionMessage(error, t("projectCatalog.error.delete")),
        );
      } finally {
        deletingUuid.value = "";
        dialog.destroy();
      }
    },
  });
}

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    await refreshRuntimeProjectCatalog().catch(() => undefined);
    const catalog = await fetchProjectCatalog();
    projects.value = catalog;
    const skipped = groupProjectsByScope(catalog).skipped;
    if (skipped.length) MessagePlugin.warning(t("projectScope.missingTeam"));
  } catch (error: any) {
    MessagePlugin.error(
      safeProjectActionMessage(error, t("projectCatalog.error.load")),
    );
  } finally {
    loading.value = false;
  }
}

defineExpose({
  openCreate: () => emit("create"),
  refresh,
});

onMounted(refresh);
</script>

<style scoped lang="scss">
.catalog {
  padding: 16px;
  margin-bottom: 20px;
  border: 1px solid var(--td-component-border);
  border-radius: 12px;
}
.catalog-title,
.catalog-title > div {
  display: flex;
  align-items: center;
  gap: 10px;
}
.catalog-title {
  justify-content: space-between;
}
.title-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.catalog-title span,
.card-meta {
  color: var(--td-text-color-secondary);
  font-size: 12px;
}
.group h3 {
  margin: 12px 0 8px;
  font-size: 14px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}
.project-card {
  border: 1px solid var(--td-component-border);
  border-radius: 10px;
  padding: 12px;
  display: grid;
  gap: 8px;
  background: var(--td-bg-color-container);
}
.card-head {
  display: grid;
  gap: 6px;
}
.card-name {
  font-size: 16px;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.recovery-alert {
  margin: 12px 0;
}
</style>

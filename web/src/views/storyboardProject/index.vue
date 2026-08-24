<template>
  <div class="storyboard-workspace" data-layout="storyboard-product-workspace">
    <StoryboardImportDialog v-if="importOpen" :project-uuid="projectUuid" :readonly="readonly || pageWriteLocked" @close="importOpen = false" @committed="handleImportCommitted" />
    <header class="storyboardHero">
      <div class="storyboardHero__identity">
        <span class="storyboardHero__mark"><t-icon name="film" /></span>
        <div class="storyboardHero__copy">
          <div class="storyboardHero__eyebrow">STORYBOARD WORKSPACE</div>
          <h1>{{ projectName }}</h1>
          <p>{{ compactProjectDescription }}</p>
          <div class="storyboardHero__actions">
            <button type="button" data-action="open-import" :disabled="readonly || pageWriteLocked" @click="openImport"><t-icon name="upload" />导入分镜</button>
            <button type="button" data-action="open-export" :disabled="hasUnsavedShotDrafts" @click="openExport"><t-icon name="download" />导出项目</button>
          </div>
        </div>
      </div>
      <div class="storyboardHero__summaries">
        <article data-summary="shots"><span>分镜总数</span><strong>{{ shots.length }}</strong><small>{{ shots.length }} 个分镜</small></article>
        <article data-summary="duration"><span>预计时长</span><strong>{{ durationLabel }}</strong><small>按当前镜头累计</small></article>
        <article data-summary="assets"><span>资产模式</span><strong>{{ sourceProjectUuid ? "共享" : "独立" }}</strong><small>{{ readonly ? "只读访问" : "可编辑" }}</small></article>
      </div>
    </header>

    <nav class="storyboardModules" aria-label="分镜项目模块">
      <button type="button" data-module="shots" class="module-interactive--sm" :class="{ active: moduleName === 'shots' }" :disabled="batchToolsBusy" @click="handleModuleChange('shots')">
        <t-icon name="view-list" /><span>分镜管理</span><small>{{ shots.length }}</small>
      </button>
      <button type="button" data-module="assets" class="module-interactive--sm" :class="{ active: moduleName === 'assets' }" :disabled="batchToolsBusy" @click="handleModuleChange('assets')">
        <t-icon name="image" /><span>资产管理</span>
      </button>
      <button type="button" data-module="settings" class="module-interactive--sm" :class="{ active: moduleName === 'settings' }" :disabled="batchToolsBusy" @click="handleModuleChange('settings')">
        <t-icon name="setting" /><span>分镜设置</span>
      </button>
    </nav>

    <div
      v-if="errorMessage || actionFeedback"
      :class="['storyboardFeedback', errorMessage ? 'is-error' : 'is-success']"
      data-feedback="storyboard-action"
      role="status"
    >
      <t-icon :name="errorMessage ? 'error-circle' : 'check-circle'" />
      <span>{{ errorMessage || actionFeedback }}</span>
      <t-button v-if="errorMessage" size="small" variant="text" :disabled="hasUnsavedShotDrafts" @click="handleRefreshShots">重新加载</t-button>
    </div>

    <section v-if="moduleName === 'shots'" class="storyboardModulePanel storyboardModulePanel--shots">
      <div class="storyboardToolbar">
        <div class="storyboardToolbar__title">
          <div>
            <strong>分镜生产</strong>
            <span data-selected-count>已选 {{ selectedShotIds.length }} 条</span>
          </div>
        </div>
        <label class="storyboardSearch">
          <t-icon name="search" />
          <input v-model="searchText" type="search" placeholder="搜索分镜提示词" />
        </label>
        <div class="storyboardToolbar__actions">
          <t-button variant="outline" data-action="toggle-select-all" :disabled="filteredShots.length === 0" @click="toggleSelectAll">
            {{ allFilteredSelected ? "取消全选" : "全选" }}
          </t-button>
          <t-button variant="outline" data-action="open-import" :disabled="readonly || pageWriteLocked" @click="openImport">导入分镜</t-button>
          <t-button
            variant="outline"
            data-action="open-batch-generation"
            :data-batch-readonly="readonly ? 'true' : 'false'"
            :data-batch-unsaved="hasUnsavedShotDrafts ? 'true' : 'false'"
            :data-batch-empty-selection="selectedShotIds.length === 0 ? 'true' : 'false'"
            :data-batch-video-ready="videoGenerationEnabled ? 'true' : 'false'"
            :disabled="Boolean(batchDisabledReason)"
            @click="openBatchGeneration"
          >
            <template #icon><t-icon name="play-circle" /></template>批量生成
          </t-button>
          <t-button
            variant="outline"
            data-action="auto-match-assets"
            :disabled="autoMatchDisabled"
            :loading="autoMatchBusy"
            @click="handleAutoMatchAssets"
          >
            自动匹配资产
          </t-button>
          <t-button
            variant="outline"
            data-action="open-batch-replace"
            :disabled="batchReplaceDisabled"
            :loading="batchReplaceBusy"
            @click="openBatchReplace"
          >
            批量替换
          </t-button>
          <t-button variant="outline" data-action="refresh-shots" :loading="loading" :disabled="hasUnsavedShotDrafts || batchToolsBusy" @click="handleRefreshShots">
            <template #icon><t-icon name="refresh" /></template>刷新
          </t-button>
          <t-button theme="primary" data-action="insert-first" :loading="inserting" :disabled="readonly || hasUnsavedShotDrafts || pageWriteLocked" @click="handleInsertShot(null)">
            <template #icon><t-icon name="add" /></template>新增分镜
          </t-button>
        </div>
      </div>
      <p data-batch-disabled-reason class="storyboardToolbar__hint">{{ batchDisabledReason }}</p>

      <div class="storyboardSplit">
        <StoryboardTable
          :key="`shots:${projectUuid}`"
          :project-uuid="projectUuid"
          :shots="filteredShots"
          :assets="assets"
          :selected-shot-uuid="selectedShotUuid"
          :selected-shot-ids="selectedShotIds"
          :loading="loading"
          :readonly="readonly || hasUnsavedShotDrafts || pageWriteLocked"
          :inserting="inserting"
          :generation-busy="generationInteractionBusy"
          :unbinding-asset-uuid="unbindingAssetUuid"
          :updating-voice-asset-uuid="updatingVoiceAssetUuid"
          :video-generation-enabled="videoGenerationEnabled"
          @select="handleSelectShot"
          @toggle-select="toggleShotSelected"
          @insert="handleInsertShot"
          @pick-asset="openAssetPicker"
          @unbind-asset="handleUnbindAsset"
          @toggle-binding-voice="handleToggleBindingVoice"
          @move="handleMoveShot"
          @remove="handleDeleteShot"
          @change-duration="handleChangeDuration"
          @preview="handlePreviewShot"
          @generate="handleRowGenerate"
          @retry="handleRetryGeneration"
        />
        <StoryboardDetailDrawer
          :key="`detail:${projectUuid}`"
          :shot="selectedShot"
          :project-uuid="projectUuid"
          :generation-settings="detailGenerationSettings"
          :generation-settings-blocked="videoModelSaveBlocked"
          :generation-busy="generationInteractionBusy"
          :candidate-busy="candidateBusy"
          :readonly="readonly || pageWriteLocked"
          @saved="handleShotSaved"
          @dirty-change="handleShotDirtyChange"
          @pick-asset="openAssetPicker"
          @select-candidate="handleSelectCandidate"
          @generation-settings-change="handleGenerationSettingsChange"
          @generate="handleGenerateShot"
        />
      </div>
    </section>

    <!-- 中文注释：资产管理必须嵌入现有塑角造景工作区，禁止再挂重复的 AssetManager。 -->
    <section
      v-else-if="moduleName === 'assets'"
      :key="`assets:${projectUuid}`"
      class="storyboardAssetWorkspace"
      data-panel="corner-scape-assets"
    >
      <StoryboardCornerScapeAssets :readonly="readonly" @changed="handleAssetCreated" />
    </section>
    <StoryboardSettings
      v-else
      :key="`settings:${projectUuid}`"
      :project-uuid="projectUuid"
      :selected-shot-uuid="selectedShotUuid"
      :provider-model="detailGenerationSettings.providerModel"
      :readonly="readonly"
    />

    <StoryboardExportDialog v-if="exportOpen" :project-uuid="projectUuid" @close="exportOpen = false" />
    <StoryboardAssetPickerDrawer
      :open="assetPickerTarget !== null"
      :target="assetPickerTarget"
      :assets="assets"
      :bindings="selectedShot?.bindings"
      :readonly="readonly"
      :busy="assetPickerBusy"
      @close="assetPickerTarget = null"
      @bind="handleBindAsset"
    />
    <StoryboardBatchGenerationDialog
      :open="batchGenerationOpen"
      :shot-count="batchShotUuids.length"
      :settings="detailGenerationSettings"
      :readonly="readonly"
      :busy="generationBusy || batchToolsBusy"
      :preview-ready="batchPreviewCache !== null"
      :preview-feedback="batchPreviewFeedback"
      @close="closeBatchGeneration"
      @settings-change="prepareBatchGenerationPreview"
      @submit="handleBatchGeneration"
    />
    <StoryboardBatchReplaceDialog
      :open="batchReplaceOpen"
      :selected-count="selectedShotIds.length"
      :prompts="selectedVideoPrompts"
      :readonly="readonly"
      :busy="batchReplaceBusy || autoMatchBusy"
      @close="closeBatchReplace"
      @submit="handleBatchReplace"
    />
    <StoryboardGenerationConfirmDialog
      :open="rowGenerationConfirmation !== null"
      :shot-number="rowGenerationConfirmation?.shotNumber || ''"
      :preview="rowGenerationConfirmation?.preview || null"
      :status="rowGenerationConfirmation?.status || ''"
      :busy="generationBusy"
      :readonly="readonly"
      @close="closeRowGenerationConfirmation"
      @confirm="confirmRowGeneration"
    />
  </div>
</template>

<script setup lang="ts">
import StoryboardExportDialog from "./components/StoryboardExportDialog.vue";
import StoryboardImportDialog from "./components/StoryboardImportDialog.vue";
import StoryboardCornerScapeAssets from "./components/StoryboardCornerScapeAssets.vue";
import StoryboardAssetPickerDrawer, { type StoryboardAssetPickerTarget } from "./components/StoryboardAssetPickerDrawer.vue";
import StoryboardBatchGenerationDialog from "./components/StoryboardBatchGenerationDialog.vue";
import StoryboardBatchReplaceDialog from "./components/StoryboardBatchReplaceDialog.vue";
import StoryboardDetailDrawer from "./components/StoryboardDetailDrawer.vue";
import StoryboardGenerationConfirmDialog from "./components/StoryboardGenerationConfirmDialog.vue";
import type { StoryboardGenerationSettingsValue } from "./components/StoryboardGenerationSettings.vue";
import StoryboardSettings from "./components/StoryboardSettings.vue";
import StoryboardTable from "./components/StoryboardTable.vue";
import { buildStoryboardSettingsUrl } from "./components/storyboardSettingsUrl";
import { useStoryboardWorkspace } from "./useStoryboardWorkspace";
import {
  isStoryboardGenerationTaskStatusActive,
  useStoryboardGenerationPolling,
} from "./useStoryboardGenerationPolling";
import {
  DEFAULT_STORYBOARD_VIDEO_RESOLUTION,
  normalizeStoryboardVideoResolution,
  type StoryboardGenerationItem,
  type WorkspaceShot,
} from "./storyboard-workbench-types";
import {
  readSafeGenerationPreviewError,
  requestStoryboardGenerationPreview,
  resolvedStoryboardGenerationMode,
  type SafeStoryboardGenerationPreview,
  type StoryboardGenerationPreviewInput,
} from "./storyboard-generation-preview";
import projectStore from "@/stores/project";
import { currentAccountScopeId, modelCatalogStore } from "@/features/models/modelCatalogStore";
import { onBeforeRouteLeave } from "vue-router";
import {
  isStoryboardVideoModelAvailable,
  videoCatalogAvailableValues,
  type StoryboardVideoCatalogState,
} from "./storyboard-video-catalog";
import { createStoryboardClientOperationId } from "./storyboard-client-operation";
import axios from "@/utils/axios";

const importOpen = ref(false);
const exportOpen = ref(false);
const searchText = ref("");
const assetPickerTarget = ref<StoryboardAssetPickerTarget | null>(null);
const unbindingAssetUuid = ref("");
const updatingVoiceAssetUuid = ref("");
const assetPickerBusyToken = ref(0);
const candidateBusyToken = ref(0);
const generationBusyToken = ref(0);
const rowPreviewBusyToken = ref(0);
const batchGenerationOpen = ref(false);
const batchReplaceOpen = ref(false);
const batchShotUuids = ref<string[]>([]);
const batchClientOperationId = ref("");
const batchIntentScope = ref("");
const batchOperationFingerprint = ref("");
const batchDialogEpoch = ref(0);
const batchPreviewCache = ref<{ key: string; items: StoryboardGenerationItem[] } | null>(null);
const batchPreviewFeedback = ref("");
const pendingBatchPreviewSettings = ref<StoryboardGenerationSettingsValue | null>(null);
const store = projectStore();
const projectUuid = computed(() => store.project?.projectUuid || "");
let projectUiEpoch = 0;
let uiOperationSequence = 0;
const assetPickerBusy = computed(() => assetPickerBusyToken.value !== 0);
const candidateBusy = computed(() => candidateBusyToken.value !== 0);
const generationBusy = computed(() => generationBusyToken.value !== 0);
const rowPreviewBusy = computed(() => rowPreviewBusyToken.value !== 0);

interface ProjectUiOwner {
  projectUuid: string;
  epoch: number;
}

interface ProjectUiOperation {
  owner: ProjectUiOwner;
  token: number;
}

function captureProjectUiOwner(): ProjectUiOwner | null {
  const ownerProjectUuid = projectUuid.value.trim();
  if (!ownerProjectUuid) return null;
  return { projectUuid: ownerProjectUuid, epoch: projectUiEpoch };
}

function ownsProjectUi(owner: ProjectUiOwner): boolean {
  return owner.epoch === projectUiEpoch && owner.projectUuid === projectUuid.value;
}

function beginProjectUiOperation(busyToken: { value: number }): ProjectUiOperation | null {
  const owner = captureProjectUiOwner();
  if (!owner) return null;
  const token = ++uiOperationSequence;
  busyToken.value = token;
  return { owner, token };
}

function finishProjectUiOperation(busyToken: { value: number }, operation: ProjectUiOperation): void {
  // 中文注释：旧项目的 finally 既不能清除 B 的新 busy，也不能在 A→B→A 后误认成当前操作。
  if (ownsProjectUi(operation.owner) && busyToken.value === operation.token) busyToken.value = 0;
}
const sourceProjectUuid = computed(() => store.project?.assetSourceProjectUuid || "");
const readonly = computed(() => (
  !store.canWrite
  || store.project?.myRole === "viewer"
  || store.project?.openMode === "readonly"
));
const projectName = computed(() => String((store.project as any)?.name || (store.project as any)?.title || "未命名分镜项目"));
const projectDescription = computed(() => String((store.project as any)?.describe || "把分镜提示词、资产绑定与视频生产集中在一个连续工作台。"));
const compactProjectDescription = computed(() => projectDescription.value);
const validatedImageProviderModel = ref("");
const imageGenerationUnavailableReason = ref("未配置图片模型");
let imageCatalogRequestEpoch = 0;
const videoCatalogState = ref<StoryboardVideoCatalogState>("checking");
const videoAvailableValues = ref<string[]>([]);
let videoCatalogRequestEpoch = 0;
const imageGenerationEnabled = computed(() => Boolean(validatedImageProviderModel.value));
const dirtyShotUuids = ref<Set<string>>(new Set());
const selectedShotIds = ref<string[]>([]);
const hasUnsavedShotDrafts = computed(() => dirtyShotUuids.value.size > 0);
type FormalGenerationOptions = Omit<StoryboardGenerationItem, "shotUuid" | "mediaType">;
type PreviewGenerationOptions = Omit<FormalGenerationOptions, "mode"> & {
  mode: FormalGenerationOptions["mode"] | "auto";
};
interface RowGenerationConfirmation {
  projectUuid: string;
  shotUuid: string;
  shotNumber: string;
  mediaType: "image" | "video";
  options: FormalGenerationOptions;
  preview: SafeStoryboardGenerationPreview;
  shotFingerprint: string;
  clientOperationId: string;
  status: string;
}
const rowGenerationConfirmation = ref<RowGenerationConfirmation | null>(null);
const generationInteractionBusy = computed(() => (
  generationBusy.value
  || rowPreviewBusy.value
  || rowGenerationConfirmation.value !== null
  || hasUnsavedShotDrafts.value
  || autoMatchBusy.value
  || batchReplaceBusy.value
));

function clearProjectScopedTransientState(): void {
  // 中文注释：所有携带旧 projectUuid、镜头或资产身份的本地状态必须在 epoch 切换时同步失效。
  projectUiEpoch += 1;
  assetPickerBusyToken.value = 0;
  unbindingAssetUuid.value = "";
  updatingVoiceAssetUuid.value = "";
  candidateBusyToken.value = 0;
  generationBusyToken.value = 0;
  rowPreviewBusyToken.value = 0;
  importOpen.value = false;
  exportOpen.value = false;
  searchText.value = "";
  assetPickerTarget.value = null;
  batchGenerationOpen.value = false;
  batchReplaceOpen.value = false;
  batchShotUuids.value = [];
  batchClientOperationId.value = "";
  batchIntentScope.value = "";
  batchOperationFingerprint.value = "";
  batchPreviewCache.value = null;
  batchPreviewFeedback.value = "";
  pendingBatchPreviewSettings.value = null;
  batchDialogEpoch.value += 1;
  rowGenerationConfirmation.value = null;
  dirtyShotUuids.value = new Set();
  selectedShotIds.value = [];
}

let notifyAcceptedGeneration: () => void = () => undefined;

const {
  moduleName,
  shots,
  assets,
  generationSettings,
  selectedShot,
  selectedShotUuid,
  totalDurationMs,
  errorMessage,
  actionFeedback,
  loading,
  inserting,
  autoMatchBusy,
  batchReplaceBusy,
  autoMatchAssets,
  batchReplacePrompt,
  refreshShots,
  refreshProductionState,
  insertAfter,
  selectShot,
  bindAsset,
  unbindAsset,
  updateBindingVoice,
  selectCandidate,
  generateShot,
  generateBatch,
  updateShotFields,
  reorderShots,
  deleteShots,
} = useStoryboardWorkspace({
  onProjectEpochChanged: clearProjectScopedTransientState,
  onGenerationAccepted: () => notifyAcceptedGeneration(),
});

const generationPolling = useStoryboardGenerationPolling({
  projectUuid,
  refreshShots,
  hasActiveTasks: () => shots.value.some((shot) => (
    shot.generationTasks?.some((task) => isStoryboardGenerationTaskStatusActive(task.status))
  )),
  onAcceptedRefreshError: () => {
    if (actionFeedback.value === "提交完成，已进入任务队列") {
      errorMessage.value = "提交完成，状态刷新失败，请手动刷新";
    }
  },
});
notifyAcceptedGeneration = generationPolling.notifyAccepted;

type VideoModelSaveState = "idle" | "saving" | "failed";
const videoModelSaveState = ref<VideoModelSaveState>("idle");
const persistedVideoModel = ref(String(store.project?.videoModel ?? "").trim());
const persistedVideoResolution = ref(
  normalizeStoryboardVideoResolution(store.project?.resolution)
  || DEFAULT_STORYBOARD_VIDEO_RESOLUTION,
);
let videoModelSaveGeneration = 0;
let videoModelSaveIntent = "";
let videoModelSaveChain: Promise<void> = Promise.resolve();

function videoGenerationSaveIntent(providerModel: string, resolution: string): string {
  return JSON.stringify({ providerModel: providerModel.trim(), resolution });
}

function resetVideoModelSaveState(): void {
  // 中文注释：项目切换后，旧项目的保存响应不得修改新项目的模型或错误状态。
  videoModelSaveGeneration += 1;
  videoModelSaveIntent = "";
  videoModelSaveChain = Promise.resolve();
  persistedVideoModel.value = String(store.project?.videoModel ?? "").trim();
  persistedVideoResolution.value = normalizeStoryboardVideoResolution(store.project?.resolution)
    || DEFAULT_STORYBOARD_VIDEO_RESOLUTION;
  videoModelSaveState.value = "idle";
}

watch(projectUuid, resetVideoModelSaveState, { flush: "sync" });

const videoModelSaveBlocked = computed(() => (
  videoModelSaveState.value !== "idle"
  || generationSettings.value.providerModel.trim() !== persistedVideoModel.value
  || normalizeStoryboardVideoResolution(generationSettings.value.resolution) !== persistedVideoResolution.value
));

function queueVideoModelSave(providerModel: string, resolution: string): void {
  const selectedModel = providerModel.trim();
  const selectedResolution = normalizeStoryboardVideoResolution(resolution);
  const owner = captureProjectUiOwner();
  if (!owner || !selectedModel || !selectedResolution || readonly.value) {
    videoModelSaveState.value = "failed";
    errorMessage.value = "视频模型保存失败，请重试";
    return;
  }
  if (
    videoModelSaveState.value === "idle"
    && persistedVideoModel.value === selectedModel
    && persistedVideoResolution.value === selectedResolution
  ) return;
  const saveIntent = videoGenerationSaveIntent(selectedModel, selectedResolution);
  if (
    videoModelSaveState.value === "saving"
    && videoModelSaveIntent === saveIntent
  ) return;

  const generation = ++videoModelSaveGeneration;
  videoModelSaveIntent = saveIntent;
  videoModelSaveState.value = "saving";
  errorMessage.value = "";
  actionFeedback.value = "正在保存视频生成配置…";

  // 中文注释：同一项目内串行保存选择，避免先发后到把用户最后一次选择覆盖回旧模型。
  const request = videoModelSaveChain
    .catch(() => undefined)
    .then(async () => {
      await axios.put(buildStoryboardSettingsUrl(owner.projectUuid), {
        videoModel: selectedModel,
        resolution: selectedResolution,
      });
    });
  videoModelSaveChain = request.then(() => undefined, () => undefined);

  void request.then(() => {
    if (
      !ownsProjectUi(owner)
      || generation !== videoModelSaveGeneration
      || generationSettings.value.providerModel.trim() !== selectedModel
      || normalizeStoryboardVideoResolution(generationSettings.value.resolution) !== selectedResolution
    ) return;
    persistedVideoModel.value = selectedModel;
    persistedVideoResolution.value = selectedResolution;
    videoModelSaveState.value = "idle";
    videoModelSaveIntent = "";
    if (store.project?.projectUuid === owner.projectUuid) {
      // 中文注释：项目创建时的模型只是初始值；保存成功后活动项目必须立即采用用户最新选择。
      store.project.videoModel = selectedModel;
      store.project.resolution = selectedResolution;
    }
    errorMessage.value = "";
    actionFeedback.value = "视频生成配置已保存";
  }).catch(() => {
    if (
      !ownsProjectUi(owner)
      || generation !== videoModelSaveGeneration
      || generationSettings.value.providerModel.trim() !== selectedModel
      || normalizeStoryboardVideoResolution(generationSettings.value.resolution) !== selectedResolution
    ) return;
    // 中文注释：错误只显示稳定中文，不回显 SQLite 路径、SQL、Cookie、令牌或堆栈。
    videoModelSaveState.value = "failed";
    videoModelSaveIntent = "";
    actionFeedback.value = "";
    errorMessage.value = "视频模型保存失败，请重试";
  });
}

const detailGenerationSettings = computed<StoryboardGenerationSettingsValue>(() => ({
  mediaType: "video",
  // 中文注释：进入项目时已经由工作区初始化；此后只读取当前明确选择，禁止重新取项目默认。
  providerModel: generationSettings.value.providerModel,
  // 中文注释：先由非收费服务端预览结合持久化镜头与绑定素材解析显式视频模式。
  mode: "auto",
  durationMs: Number(selectedShot.value?.durationMs ?? generationSettings.value.durationMs ?? 5000),
  aspectRatio: selectedShot.value?.aspectRatio ?? generationSettings.value.aspectRatio ?? "9:16",
  resolution: normalizeStoryboardVideoResolution(generationSettings.value.resolution)
    || DEFAULT_STORYBOARD_VIDEO_RESOLUTION,
}));

function isCurrentVideoModelAvailable(providerModel: string): boolean {
  return isStoryboardVideoModelAvailable({
    catalogState: videoCatalogState.value,
    availableValues: videoAvailableValues.value,
    providerModel,
  });
}

const videoGenerationEnabled = computed(() => (
  !videoModelSaveBlocked.value
  && isCurrentVideoModelAvailable(detailGenerationSettings.value.providerModel)
));

const batchToolsBusy = computed(() => autoMatchBusy.value || batchReplaceBusy.value);
const pageWriteLocked = computed(() => batchToolsBusy.value);
const batchDisabledReason = computed(() => {
  if (readonly.value) return "当前为只读，不能批量生成";
  if (hasUnsavedShotDrafts.value) return "请先保存分镜内容";
  if (batchToolsBusy.value) return "正在处理批量修改";
  if (selectedShotIds.value.length === 0) return "请先勾选要生成的分镜";
  if (videoModelSaveBlocked.value) return "视频模型保存失败，请重试";
  if (!videoGenerationEnabled.value) return "当前账号未配置可用视频模型";
  return "";
});
const autoMatchDisabled = computed(() => (
  readonly.value
  || hasUnsavedShotDrafts.value
  || selectedShotIds.value.length === 0
  || assets.value.length === 0
  || batchToolsBusy.value
));
const batchReplaceDisabled = computed(() => (
  readonly.value
  || hasUnsavedShotDrafts.value
  || selectedShotIds.value.length === 0
  || batchToolsBusy.value
));
const selectedVideoPrompts = computed(() => selectedShotIds.value.map((shotUuid) => {
  const shot = shots.value.find((item) => item.shotUuid === shotUuid);
  return String(shot?.videoPrompt ?? "");
}));

async function loadWorkspaceVideoCatalog(): Promise<void> {
  const scope = currentAccountScopeId();
  const requestEpoch = ++videoCatalogRequestEpoch;
  // 中文注释：账号切换或重新探测必须先进入 checking 并清空旧 availableValues，旧模型立即失效。
  videoCatalogState.value = "checking";
  videoAvailableValues.value = [];
  try {
    const next = await modelCatalogStore.ensure(scope, "video");
    if (requestEpoch !== videoCatalogRequestEpoch || currentAccountScopeId() !== scope) return;
    videoAvailableValues.value = videoCatalogAvailableValues(next.items ?? []);
    videoCatalogState.value = modelCatalogStore.failure(scope, "video") ? "failed" : "ready";
    const current = generationSettings.value.providerModel.trim();
    if (current && !videoAvailableValues.value.includes(current)) {
      // 中文注释：显式选择失效必须清空并要求重选，不能静默回填项目默认或目录首项。
      generationSettings.value = { ...generationSettings.value, providerModel: "" };
      errorMessage.value = "当前选择的视频模型已不可用，请重新选择";
    }
  } catch {
    if (requestEpoch !== videoCatalogRequestEpoch) return;
    videoCatalogState.value = "failed";
    videoAvailableValues.value = [];
  }
}

function handleGenerationSettingsChange(settings: StoryboardGenerationSettingsValue): void {
  // 中文注释：抽屉是用户当前选择入口，行级、批量和项目设置都消费同一个响应式真源。
  generationSettings.value = {
    mediaType: "video",
    providerModel: settings.providerModel,
    mode: settings.mode,
    durationMs: settings.durationMs,
    aspectRatio: settings.aspectRatio,
    resolution: settings.resolution,
  };
  queueVideoModelSave(settings.providerModel, settings.resolution);
}

const durationLabel = computed(() => {
  const seconds = Math.round(totalDurationMs.value / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}分${String(seconds % 60).padStart(2, "0")}秒`;
});

const filteredShots = computed(() => {
  const keyword = searchText.value.trim().toLowerCase();
  if (!keyword) return shots.value;
  return shots.value.filter((shot) => [shot.videoPrompt, shot.visualDescription, shot.sourceText]
    .some((value) => String(value ?? "").toLowerCase().includes(keyword)));
});
const allFilteredSelected = computed(() => (
  filteredShots.value.length > 0 && filteredShots.value.every((shot) => selectedShotIds.value.includes(shot.shotUuid))
));

async function handleImportCommitted() {
  const owner = captureProjectUiOwner();
  if (!owner) return;
  importOpen.value = false;
  await refreshShots();
  if (!ownsProjectUi(owner)) return;
}

function openImport(): void {
  if (readonly.value || hasUnsavedShotDrafts.value || pageWriteLocked.value) {
    if (hasUnsavedShotDrafts.value) errorMessage.value = "请先保存分镜内容";
    return;
  }
  importOpen.value = true;
}

function openExport(): void {
  if (hasUnsavedShotDrafts.value) {
    errorMessage.value = "请先保存分镜内容";
    return;
  }
  exportOpen.value = true;
}

function handleModuleChange(nextModule: "shots" | "assets" | "settings"): void {
  if (batchToolsBusy.value) return;
  if (nextModule === moduleName.value) return;
  if (hasUnsavedShotDrafts.value) {
    errorMessage.value = "请先保存分镜内容";
    return;
  }
  moduleName.value = nextModule;
}

async function handleRefreshShots(): Promise<void> {
  if (hasUnsavedShotDrafts.value) {
    errorMessage.value = "请先保存分镜内容";
    return;
  }
  if (batchToolsBusy.value) return;
  const owner = captureProjectUiOwner();
  if (!owner) return;
  await refreshShots();
  if (!ownsProjectUi(owner)) return;
  retainExistingShotSelection();
}

function handleSelectShot(shotUuid: string): void {
  if (!shotUuid || shotUuid === selectedShotUuid.value) return;
  if (hasUnsavedShotDrafts.value) {
    errorMessage.value = "请先保存分镜内容";
    return;
  }
  selectShot(shotUuid);
}

async function handleInsertShot(afterShotUuid: string | null): Promise<void> {
  if (readonly.value || hasUnsavedShotDrafts.value || pageWriteLocked.value) return;
  await insertAfter(afterShotUuid);
}

async function handleShotSaved(): Promise<void> {
  if (pageWriteLocked.value) return;
  const owner = captureProjectUiOwner();
  const shotUuid = selectedShotUuid.value;
  if (!owner || !shotUuid) return;
  handleShotDirtyChange({ shotUuid, dirty: false });
  await refreshShots(shotUuid);
  if (!ownsProjectUi(owner)) return;
}

function normalizeAssetPickerTarget(
  targetOrShotUuid: StoryboardAssetPickerTarget | string,
  assetType?: StoryboardAssetPickerTarget["assetType"],
): StoryboardAssetPickerTarget | null {
  if (typeof targetOrShotUuid === "object" && targetOrShotUuid?.shotUuid && targetOrShotUuid.assetType) {
    const shot = shots.value.find((item) => item.shotUuid === targetOrShotUuid.shotUuid);
    return { ...targetOrShotUuid, shotNumber: shot?.displayOrder };
  }
  if (typeof targetOrShotUuid === "string" && assetType && ["role", "scene", "tool"].includes(assetType)) {
    const shot = shots.value.find((item) => item.shotUuid === targetOrShotUuid);
    return { shotUuid: targetOrShotUuid, assetType, shotNumber: shot?.displayOrder };
  }
  return null;
}

function openAssetPicker(
  targetOrShotUuid: StoryboardAssetPickerTarget | string,
  assetType?: StoryboardAssetPickerTarget["assetType"],
): void {
  if (readonly.value || hasUnsavedShotDrafts.value || pageWriteLocked.value) {
    if (hasUnsavedShotDrafts.value) errorMessage.value = "请先保存分镜内容";
    return;
  }
  const target = normalizeAssetPickerTarget(targetOrShotUuid, assetType);
  if (!target) return;
  selectShot(target.shotUuid);
  assetPickerTarget.value = target;
}

async function handleUnbindAsset(input: {
  shotUuid: string;
  assetUuid: string;
  assetType: "role" | "scene" | "tool" | "clip" | "audio";
  relationRole: string;
  sourceProjectUuid: string;
}): Promise<void> {
  if (readonly.value || hasUnsavedShotDrafts.value || pageWriteLocked.value) return;
  if (unbindingAssetUuid.value === input.assetUuid) return;
  const previous = unbindingAssetUuid.value;
  unbindingAssetUuid.value = input.assetUuid;
  const operation = beginProjectUiOperation(assetPickerBusyToken);
  if (!operation) {
    unbindingAssetUuid.value = previous;
    return;
  }
  try {
    await unbindAsset(input.shotUuid, input);
  } finally {
    if (unbindingAssetUuid.value === input.assetUuid) unbindingAssetUuid.value = "";
    finishProjectUiOperation(assetPickerBusyToken, operation);
  }
}

async function handleBindAsset(input: {
  shotUuid: string;
  assetUuid: string;
  assetType: "role" | "scene" | "tool";
  relationRole: "appear";
  sourceProjectUuid: string;
}): Promise<void> {
  if (readonly.value || hasUnsavedShotDrafts.value || assetPickerBusy.value || pageWriteLocked.value) return;
  const operation = beginProjectUiOperation(assetPickerBusyToken);
  if (!operation) return;
  try {
    const bound = await bindAsset(input.shotUuid, input);
    if (ownsProjectUi(operation.owner) && bound) assetPickerTarget.value = null;
  } finally {
    finishProjectUiOperation(assetPickerBusyToken, operation);
  }
}

async function handleSelectCandidate(
  inputOrShotUuid: { shotUuid: string; candidateUuid: string } | string,
  candidateUuid?: string,
): Promise<void> {
  const input = typeof inputOrShotUuid === "string"
    ? { shotUuid: inputOrShotUuid, candidateUuid: candidateUuid ?? "" }
    : inputOrShotUuid;
  if (
    !input.shotUuid
    || !input.candidateUuid
    || readonly.value
    || hasUnsavedShotDrafts.value
    || candidateBusy.value
    || pageWriteLocked.value
  ) return;
  const operation = beginProjectUiOperation(candidateBusyToken);
  if (!operation) return;
  try {
    await selectCandidate(input.shotUuid, input.candidateUuid);
  } finally {
    finishProjectUiOperation(candidateBusyToken, operation);
  }
}

async function handleGenerateShot(input: {
  shotUuid: string;
  settings: StoryboardGenerationSettingsValue & {
    expectedPreviewDigest: string;
    routeKind: SafeStoryboardGenerationPreview["routeKind"];
    clientOperationId: string;
  };
}): Promise<void> {
  if (
    readonly.value
    || generationBusy.value
    || dirtyShotUuids.value.has(input.shotUuid)
    || pageWriteLocked.value
  ) return;
  if (videoModelSaveBlocked.value) {
    errorMessage.value = "视频模型保存失败，请重试";
    return;
  }
  if (!isCurrentVideoModelAvailable(input.settings.providerModel)) {
    errorMessage.value = "当前账号未配置可用视频模型";
    return;
  }
  if (String(input.settings.mode) === "auto") {
    errorMessage.value = "请先完成服务端预览";
    return;
  }
  const operation = beginProjectUiOperation(generationBusyToken);
  if (!operation) return;
  try {
    await generateShot(input.shotUuid, "video", {
      providerModel: input.settings.providerModel,
      mode: input.settings.mode as StoryboardGenerationItem["mode"],
      // 中文注释：正式提交必须携带预览确认的路由种类，服务端继续做模型与路由一致性校验。
      routeKind: input.settings.routeKind,
      durationMs: input.settings.durationMs,
      aspectRatio: input.settings.aspectRatio,
      resolution: input.settings.resolution,
      expectedPreviewDigest: input.settings.expectedPreviewDigest,
    }, input.settings.clientOperationId);
  } finally {
    finishProjectUiOperation(generationBusyToken, operation);
  }
}

function generationSettingsForShot(shotUuid: string): StoryboardGenerationSettingsValue {
  const shot = shots.value.find((item) => item.shotUuid === shotUuid);
  return {
    ...detailGenerationSettings.value,
    // 有绑定素材时必须让服务端选择 image2video / multiframe / multimodal，前端不得猜成 text2video。
    mode: shot?.bindings?.length ? "auto" : detailGenerationSettings.value.mode,
    durationMs: Number(shot?.durationMs ?? generationSettings.value.durationMs ?? 5000),
    aspectRatio: shot?.aspectRatio ?? generationSettings.value.aspectRatio ?? "9:16",
  };
}

function generationShotFingerprint(shot: WorkspaceShot | undefined): string {
  if (!shot) return "";
  return JSON.stringify({
    shotUuid: shot.shotUuid,
    visualDescription: shot.visualDescription ?? "",
    imagePrompt: shot.imagePrompt ?? "",
    videoPrompt: shot.videoPrompt ?? "",
    negativePrompt: shot.negativePrompt ?? "",
    aspectRatio: shot.aspectRatio ?? "",
    durationMs: shot.durationMs ?? 0,
    bindings: shot.bindings ?? [],
  });
}

function generationPreviewInput(
  shot: WorkspaceShot,
  mediaType: "image" | "video",
  options: PreviewGenerationOptions,
): StoryboardGenerationPreviewInput {
  return {
    shotUuid: shot.shotUuid,
    mediaType,
    ...options,
    shot: {
      visualDescription: shot.visualDescription,
      imagePrompt: shot.imagePrompt,
      videoPrompt: shot.videoPrompt,
      negativePrompt: shot.negativePrompt,
      aspectRatio: options.aspectRatio ?? shot.aspectRatio,
      durationMs: options.durationMs ?? shot.durationMs,
      bindings: shot.bindings?.map((binding) => ({ ...binding })),
    },
  };
}

function handleShotDirtyChange(input: { shotUuid: string; dirty: boolean }): void {
  if (!input.shotUuid) return;
  const next = new Set(dirtyShotUuids.value);
  if (input.dirty) next.add(input.shotUuid);
  else next.delete(input.shotUuid);
  dirtyShotUuids.value = next;
}

async function handleRowGenerate(
  inputOrShotUuid: { shotUuid: string; mediaType: "image" | "video" } | string,
  mediaType?: "image" | "video",
): Promise<void> {
  const input = typeof inputOrShotUuid === "string"
    ? { shotUuid: inputOrShotUuid, mediaType }
    : inputOrShotUuid;
  if (
    !input.shotUuid
    || readonly.value
    || generationInteractionBusy.value
    || (input.mediaType !== "image" && input.mediaType !== "video")
  ) return;

  if (input.mediaType === "image") {
    if (!imageGenerationEnabled.value) {
      errorMessage.value = imageGenerationUnavailableReason.value;
      return;
    }
    const settings = generationSettingsForShot(input.shotUuid);
    await openRowGenerationConfirmation(input.shotUuid, "image", {
      providerModel: validatedImageProviderModel.value,
      mode: "text2image",
      durationMs: settings.durationMs,
      aspectRatio: settings.aspectRatio,
    });
    return;
  }

  const settings = generationSettingsForShot(input.shotUuid);
  if (videoModelSaveBlocked.value) {
    errorMessage.value = "视频模型保存失败，请重试";
    return;
  }
  if (!isCurrentVideoModelAvailable(settings.providerModel)) {
    errorMessage.value = "当前账号未配置可用视频模型";
    return;
  }
  await openRowGenerationConfirmation(input.shotUuid, "video", {
    providerModel: settings.providerModel,
    mode: settings.mode,
    durationMs: settings.durationMs,
    aspectRatio: settings.aspectRatio,
    resolution: settings.resolution,
  });
}

async function openRowGenerationConfirmation(
  shotUuid: string,
  mediaType: "image" | "video",
  options: PreviewGenerationOptions,
): Promise<void> {
  if (readonly.value || generationInteractionBusy.value || dirtyShotUuids.value.has(shotUuid) || pageWriteLocked.value) return;
  const shot = shots.value.find((item) => item.shotUuid === shotUuid);
  if (!shot) return;
  const operation = beginProjectUiOperation(rowPreviewBusyToken);
  if (!operation) return;
  const projectAtRequest = operation.owner.projectUuid;
  const shotFingerprint = generationShotFingerprint(shot);
  errorMessage.value = "";
  try {
    const preview = await requestStoryboardGenerationPreview(
      projectAtRequest,
      generationPreviewInput(shot, mediaType, options),
    );
    if (!ownsProjectUi(operation.owner)) return;
    // 中文注释：非收费预览返回前若权限或镜头已变化，旧响应不得打开收费确认。
    if (
      readonly.value
      || dirtyShotUuids.value.has(shotUuid)
      || generationShotFingerprint(shots.value.find((item) => item.shotUuid === shotUuid)) !== shotFingerprint
    ) {
      errorMessage.value = readonly.value ? "项目权限已变化，已取消预览" : "分镜内容已变化，请重新预览";
      return;
    }
    const mode = resolvedStoryboardGenerationMode(preview, mediaType);
    rowGenerationConfirmation.value = {
      projectUuid: projectAtRequest,
      shotUuid,
      shotNumber: String(shot.displayOrder).padStart(2, "0"),
      mediaType,
      options: { ...options, mode },
      preview,
      shotFingerprint,
      clientOperationId: createStoryboardClientOperationId(),
      status: "",
    };
    selectShot(shotUuid);
  } catch (error) {
    if (ownsProjectUi(operation.owner)) {
      errorMessage.value = readSafeGenerationPreviewError(error, "生成预览失败，请重试");
    }
  } finally {
    finishProjectUiOperation(rowPreviewBusyToken, operation);
  }
}

function closeRowGenerationConfirmation(): void {
  if (generationBusy.value) return;
  rowGenerationConfirmation.value = null;
}

async function confirmRowGeneration(): Promise<void> {
  const confirmation = rowGenerationConfirmation.value;
  if (!confirmation || generationBusy.value) return;
  if (readonly.value) {
    confirmation.status = "项目权限已变化，已取消生成";
    return;
  }
  if (confirmation.mediaType === "video" && !isCurrentVideoModelAvailable(confirmation.options.providerModel)) {
    confirmation.status = "当前账号未配置可用视频模型";
    return;
  }
  if (projectUuid.value !== confirmation.projectUuid) {
    confirmation.status = "项目已切换，请关闭后重新预览";
    return;
  }
  const currentShot = shots.value.find((shot) => shot.shotUuid === confirmation.shotUuid);
  if (generationShotFingerprint(currentShot) !== confirmation.shotFingerprint) {
    confirmation.status = "分镜内容已变化，请关闭后重新预览";
    return;
  }
  const operation = beginProjectUiOperation(generationBusyToken);
  if (!operation) return;
  try {
    // 中文注释：确认按钮只使用用户已核对的摘要；服务端会重新构建请求并权威拒绝摘要漂移。
    if (
      readonly.value
      || projectUuid.value !== confirmation.projectUuid
      || rowGenerationConfirmation.value !== confirmation
      || dirtyShotUuids.value.has(confirmation.shotUuid)
      || generationShotFingerprint(shots.value.find((shot) => shot.shotUuid === confirmation.shotUuid)) !== confirmation.shotFingerprint
    ) {
      confirmation.status = readonly.value
        ? "项目权限已变化，已取消生成"
        : projectUuid.value !== confirmation.projectUuid
          ? "项目已切换，请关闭后重新预览"
          : "分镜内容已变化，请关闭后重新预览";
      return;
    }
    if (confirmation.mediaType === "video" && !isCurrentVideoModelAvailable(confirmation.options.providerModel)) {
      confirmation.status = "当前账号未配置可用视频模型";
      return;
    }
    const submitted = await generateShot(
      confirmation.shotUuid,
      confirmation.mediaType,
      {
        ...confirmation.options,
        routeKind: confirmation.preview.routeKind,
        expectedPreviewDigest: confirmation.preview.previewDigest,
      },
      confirmation.clientOperationId,
    );
    if (!ownsProjectUi(operation.owner)) return;
    if (submitted) rowGenerationConfirmation.value = null;
  } catch {
    if (ownsProjectUi(operation.owner) && rowGenerationConfirmation.value === confirmation) {
      confirmation.status = "提交失败，请重试";
    }
  } finally {
    finishProjectUiOperation(generationBusyToken, operation);
  }
}

async function handleRetryGeneration(
  inputOrTaskUuid: { taskUuid: string; shotUuid: string; mediaType: "image" | "video" } | string,
  shotUuid?: string,
  mediaType?: "image" | "video",
): Promise<void> {
  const input = typeof inputOrTaskUuid === "string"
    ? { taskUuid: inputOrTaskUuid, shotUuid: shotUuid ?? "", mediaType }
    : inputOrTaskUuid;
  if (
    !input.taskUuid
    || !input.shotUuid
    || readonly.value
    || generationInteractionBusy.value
    || (input.mediaType !== "image" && input.mediaType !== "video")
  ) return;
  const sourceTaskExists = shots.value.some((shot) => (
    shot.shotUuid === input.shotUuid
    && shot.generationTasks?.some((task) => (
      task.taskUuid === input.taskUuid
      && task.mediaType === input.mediaType
      && task.status.trim().toLowerCase().startsWith("failed")
    ))
  ));
  if (!sourceTaskExists) return;
  // taskUuid 只用于确认失败来源；后端没有“重放原任务”合同，因此按当前镜头配置新建任务。
  await handleRowGenerate(input.shotUuid, input.mediaType);
}

function toggleShotSelected(shotUuid: string): void {
  const next = new Set(selectedShotIds.value);
  if (next.has(shotUuid)) next.delete(shotUuid);
  else next.add(shotUuid);
  selectedShotIds.value = [...next];
}

function toggleSelectAll(): void {
  if (allFilteredSelected.value) {
    selectedShotIds.value = [];
    return;
  }
  selectedShotIds.value = filteredShots.value.map((shot) => shot.shotUuid);
}

async function handleToggleBindingVoice(input: {
  shotUuid: string;
  assetUuid: string;
  assetType: "role" | "scene" | "tool" | "clip" | "audio";
  relationRole: string;
  sourceProjectUuid: string;
  voiceEnabled: boolean;
}): Promise<void> {
  if (readonly.value || hasUnsavedShotDrafts.value || pageWriteLocked.value) {
    if (hasUnsavedShotDrafts.value) errorMessage.value = "请先保存分镜内容";
    return;
  }
  if (updatingVoiceAssetUuid.value === input.assetUuid) return;
  const previous = updatingVoiceAssetUuid.value;
  updatingVoiceAssetUuid.value = input.assetUuid;
  const operation = beginProjectUiOperation(assetPickerBusyToken);
  if (!operation) {
    updatingVoiceAssetUuid.value = previous;
    return;
  }
  try {
    await updateBindingVoice(input.shotUuid, input);
  } finally {
    if (updatingVoiceAssetUuid.value === input.assetUuid) updatingVoiceAssetUuid.value = "";
    finishProjectUiOperation(assetPickerBusyToken, operation);
  }
}

async function handleChangeDuration(shotUuid: string, durationMs: number): Promise<void> {
  if (readonly.value || hasUnsavedShotDrafts.value || pageWriteLocked.value) {
    if (hasUnsavedShotDrafts.value) errorMessage.value = "请先保存分镜内容";
    return;
  }
  await updateShotFields(shotUuid, { durationMs });
}

async function handleMoveShot(shotUuid: string, direction: "up" | "down"): Promise<void> {
  if (readonly.value || hasUnsavedShotDrafts.value || generationInteractionBusy.value || pageWriteLocked.value) {
    if (hasUnsavedShotDrafts.value) errorMessage.value = "请先保存分镜内容";
    return;
  }
  const ordered = shots.value.map((shot) => shot.shotUuid);
  const index = ordered.indexOf(shotUuid);
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || swapWith < 0 || swapWith >= ordered.length) return;
  const next = [...ordered];
  const current = next[index]!;
  next[index] = next[swapWith]!;
  next[swapWith] = current;
  await reorderShots(next);
}

async function handleDeleteShot(shotUuid: string): Promise<void> {
  if (readonly.value || hasUnsavedShotDrafts.value || generationInteractionBusy.value || pageWriteLocked.value) {
    if (hasUnsavedShotDrafts.value) errorMessage.value = "请先保存分镜内容";
    return;
  }
  if (!window.confirm("确认删除该分镜？此操作不可撤销。")) return;
  await deleteShots([shotUuid]);
  selectedShotIds.value = selectedShotIds.value.filter((item) => item !== shotUuid);
}

function handlePreviewShot(shotUuid: string): void {
  handleSelectShot(shotUuid);
}

function handleAssetCreated(): void {
  void refreshProductionState();
}

function retainExistingShotSelection(): void {
  const active = new Set(shots.value.map((shot) => shot.shotUuid));
  selectedShotIds.value = selectedShotIds.value.filter((shotUuid) => active.has(shotUuid));
}

async function handleAutoMatchAssets(): Promise<void> {
  if (autoMatchDisabled.value) return;
  const owner = captureProjectUiOwner();
  if (!owner) return;
  const frozen = [...selectedShotIds.value];
  await autoMatchAssets(frozen);
  if (!ownsProjectUi(owner)) return;
  retainExistingShotSelection();
}

function openBatchReplace(): void {
  if (batchReplaceDisabled.value) return;
  batchReplaceOpen.value = true;
}

function closeBatchReplace(): void {
  batchReplaceOpen.value = false;
}

async function handleBatchReplace(input: { findText: string; replaceText: string }): Promise<void> {
  if (batchReplaceDisabled.value || !input.findText || input.findText === input.replaceText) return;
  const owner = captureProjectUiOwner();
  if (!owner) return;
  const frozen = [...selectedShotIds.value];
  const submitted = await batchReplacePrompt(frozen, input.findText, input.replaceText);
  if (!ownsProjectUi(owner)) return;
  retainExistingShotSelection();
  if (submitted) batchReplaceOpen.value = false;
}

function openBatchGeneration(): void {
  if (
    readonly.value
    || hasUnsavedShotDrafts.value
    || selectedShotIds.value.length === 0
    || pageWriteLocked.value
  ) return;
  if (videoModelSaveBlocked.value) {
    errorMessage.value = "视频模型保存失败，请重试";
    return;
  }
  if (!videoGenerationEnabled.value) {
    // 中文注释：打开批量弹窗也必须消费同一目录有效状态，禁止只靠按钮 disabled 被 trigger 绕过。
    errorMessage.value = "当前账号未配置可用视频模型";
    return;
  }
  // 中文注释：批量生成只使用当前勾选集合，不得隐式扩大到搜索结果或全部分镜。
  batchShotUuids.value = selectedShotIds.value.filter((shotUuid) => shots.value.some((shot) => shot.shotUuid === shotUuid));
  batchIntentScope.value = JSON.stringify({ projectUuid: projectUuid.value, shotUuids: batchShotUuids.value });
  batchClientOperationId.value = "";
  batchOperationFingerprint.value = "";
  batchPreviewCache.value = null;
  batchPreviewFeedback.value = "正在准备非收费预览…";
  pendingBatchPreviewSettings.value = null;
  batchDialogEpoch.value += 1;
  batchGenerationOpen.value = true;
}

function closeBatchGeneration(): void {
  batchGenerationOpen.value = false;
  batchClientOperationId.value = "";
  batchOperationFingerprint.value = "";
  batchPreviewCache.value = null;
  batchPreviewFeedback.value = "";
  pendingBatchPreviewSettings.value = null;
  batchDialogEpoch.value += 1;
}

function batchPreviewKey(
  settings: StoryboardGenerationSettingsValue,
  shotUuids = batchShotUuids.value,
): string {
  return JSON.stringify({
    projectUuid: projectUuid.value,
    shotUuids,
    shotFingerprints: shotUuids.map((shotUuid) => generationShotFingerprint(
      shots.value.find((shot) => shot.shotUuid === shotUuid),
    )),
    settings,
  });
}

async function prepareBatchGenerationPreview(input: { settings: StoryboardGenerationSettingsValue }): Promise<void> {
  if (generationBusy.value) {
    // 中文注释：设置变化只保留最后一份待预览值，当前请求结束后续跑，避免并发预览堆积。
    pendingBatchPreviewSettings.value = { ...input.settings };
    batchPreviewCache.value = null;
    batchPreviewFeedback.value = "设置已变化，正在重新准备预览…";
    return;
  }
  if (
    !batchGenerationOpen.value
    || readonly.value
    || !isCurrentVideoModelAvailable(input.settings.providerModel)
  ) return;
  const operation = beginProjectUiOperation(generationBusyToken);
  if (!operation) return;
  const dialogEpochAtRequest = batchDialogEpoch.value;
  const frozenShotUuids = [...batchShotUuids.value];
  const cacheKey = batchPreviewKey(input.settings, frozenShotUuids);
  if (batchPreviewCache.value?.key === cacheKey) {
    finishProjectUiOperation(generationBusyToken, operation);
    return;
  }
  batchPreviewCache.value = null;
  batchPreviewFeedback.value = "正在准备非收费预览…";
  try {
    const previewInputs = frozenShotUuids.map((shotUuid) => {
      const shot = shots.value.find((item) => item.shotUuid === shotUuid);
      if (!shot) throw new Error("批量镜头已变化");
      const settings = generationSettingsForShot(shotUuid);
      return generationPreviewInput(shot, "video", {
        providerModel: input.settings.providerModel,
        mode: shot.bindings?.length ? "auto" : input.settings.mode,
        durationMs: Number(input.settings.durationMs ?? settings.durationMs),
        aspectRatio: input.settings.aspectRatio || settings.aspectRatio,
        resolution: input.settings.resolution || settings.resolution,
      });
    });
    const previews = await Promise.all(previewInputs.map((previewInput) => (
      requestStoryboardGenerationPreview(operation.owner.projectUuid, previewInput)
    )));
    if (
      !ownsProjectUi(operation.owner)
      || !batchGenerationOpen.value
      || batchDialogEpoch.value !== dialogEpochAtRequest
      || batchPreviewKey(input.settings, frozenShotUuids) !== cacheKey
    ) return;
    if (readonly.value) {
      batchPreviewFeedback.value = "项目权限已变化，已取消生成";
      return;
    }
    if (!isCurrentVideoModelAvailable(input.settings.providerModel)) {
      batchPreviewFeedback.value = "当前账号未配置可用视频模型";
      return;
    }
    batchPreviewCache.value = {
      key: cacheKey,
      items: previewInputs.map((previewInput, index) => ({
        shotUuid: previewInput.shotUuid,
        mediaType: "video",
        providerModel: previewInput.providerModel,
        routeKind: previews[index].routeKind,
        mode: resolvedStoryboardGenerationMode(previews[index], "video"),
        durationMs: previewInput.durationMs,
        aspectRatio: previewInput.aspectRatio,
        resolution: previewInput.resolution,
        expectedPreviewDigest: previews[index].previewDigest,
      })),
    };
    batchPreviewFeedback.value = "预览已就绪，确认后将立即进入任务队列";
  } catch (error) {
    if (ownsProjectUi(operation.owner)) {
      batchPreviewFeedback.value = readSafeGenerationPreviewError(error, "批量生成预览失败，请重试");
    }
  } finally {
    finishProjectUiOperation(generationBusyToken, operation);
    const pending = pendingBatchPreviewSettings.value;
    pendingBatchPreviewSettings.value = null;
    if (pending && batchGenerationOpen.value) {
      void prepareBatchGenerationPreview({ settings: pending });
    }
  }
}

async function handleBatchGeneration(input: { settings: StoryboardGenerationSettingsValue; paidConfirmed: true }): Promise<void> {
  if (
    readonly.value
    || generationBusy.value
    || hasUnsavedShotDrafts.value
    || batchToolsBusy.value
  ) return;
  if (videoModelSaveBlocked.value) {
    errorMessage.value = "视频模型保存失败，请重试";
    return;
  }
  if (!isCurrentVideoModelAvailable(input.settings.providerModel)) {
    errorMessage.value = "当前账号未配置可用视频模型";
    return;
  }
  if (
    batchIntentScope.value !== JSON.stringify({ projectUuid: projectUuid.value, shotUuids: batchShotUuids.value })
  ) {
    errorMessage.value = "批量镜头已变化，请重新确认";
    return;
  }
  const operation = beginProjectUiOperation(generationBusyToken);
  if (!operation) return;
  try {
    const projectAtRequest = operation.owner.projectUuid;
    const frozenShotUuids = [...batchShotUuids.value];
    const cached = batchPreviewCache.value;
    if (!cached || cached.key !== batchPreviewKey(input.settings, frozenShotUuids)) {
      batchPreviewCache.value = null;
      pendingBatchPreviewSettings.value = { ...input.settings };
      batchPreviewFeedback.value = "设置或分镜已变化，请等待预览重新完成";
      return;
    }
    const items = cached.items;
    const operationFingerprint = JSON.stringify({
      projectUuid: projectAtRequest,
      paidBatchConfirmed: input.paidConfirmed,
      // 中文注释：数组顺序属于幂等合同；相同镜头不同顺序也必须视为新的收费意图。
      items,
    });
    if (
      batchOperationFingerprint.value
      && batchOperationFingerprint.value !== operationFingerprint
    ) {
      // 中文注释：旧请求结果未知时，最终载荷变化必须先失效旧意图；本次确认绝不直接再发一批收费请求。
      batchClientOperationId.value = "";
      batchOperationFingerprint.value = operationFingerprint;
      errorMessage.value = "批量生成内容已变化，请重新确认";
      return;
    }
    if (batchOperationFingerprint.value !== operationFingerprint) {
      batchOperationFingerprint.value = operationFingerprint;
    }
    if (!batchClientOperationId.value) batchClientOperationId.value = createStoryboardClientOperationId();
    const submitted = await generateBatch(items, input.paidConfirmed, batchClientOperationId.value);
    if (!ownsProjectUi(operation.owner)) return;
    if (submitted) closeBatchGeneration();
  } catch (error) {
    if (ownsProjectUi(operation.owner)) {
      errorMessage.value = readSafeGenerationPreviewError(error, "批量生成预览失败，请重试");
    }
  } finally {
    finishProjectUiOperation(generationBusyToken, operation);
    const pending = pendingBatchPreviewSettings.value;
    pendingBatchPreviewSettings.value = null;
    if (pending && batchGenerationOpen.value) {
      void prepareBatchGenerationPreview({ settings: pending });
    }
  }
}

onMounted(() => {
  void refreshProductionState();
});

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (!hasUnsavedShotDrafts.value) return;
  // 中文注释：使用浏览器/Electron 原生离开保护，不弹自造异步确认框。
  event.preventDefault();
  event.returnValue = "";
}

onMounted(() => window.addEventListener("beforeunload", handleBeforeUnload));
onBeforeUnmount(() => window.removeEventListener("beforeunload", handleBeforeUnload));

onBeforeRouteLeave(() => {
  if (!hasUnsavedShotDrafts.value) return true;
  errorMessage.value = "请先保存分镜内容";
  return false;
});

watch(
  () => shots.value.map((shot) => shot.shotUuid),
  (activeShotUuids) => {
    const active = new Set(activeShotUuids);
    const next = new Set([...dirtyShotUuids.value].filter((shotUuid) => active.has(shotUuid)));
    if (next.size !== dirtyShotUuids.value.size) dirtyShotUuids.value = next;
    selectedShotIds.value = selectedShotIds.value.filter((shotUuid) => active.has(shotUuid));
  },
  { deep: false },
);

watch(
  () => currentAccountScopeId(),
  () => {
    void loadWorkspaceVideoCatalog();
  },
  { immediate: true },
);

watch(
  () => [projectUuid.value, String(store.project?.imageModel ?? "").trim()] as const,
  async ([activeProjectUuid, configuredProviderModel]) => {
    const requestEpoch = ++imageCatalogRequestEpoch;
    validatedImageProviderModel.value = "";
    imageGenerationUnavailableReason.value = "未配置图片模型";
    if (!activeProjectUuid || !configuredProviderModel) return;
    if (configuredProviderModel.startsWith("dreamina-cli:")) {
      imageGenerationUnavailableReason.value = "图片模型配置无效";
      return;
    }
    const separator = configuredProviderModel.indexOf(":");
    if (separator <= 0 || separator === configuredProviderModel.length - 1) {
      imageGenerationUnavailableReason.value = "图片模型配置无效";
      return;
    }
    const providerId = configuredProviderModel.slice(0, separator);
    const modelValue = configuredProviderModel.slice(separator + 1);
    try {
      const catalog = await modelCatalogStore.ensure(currentAccountScopeId(), "image");
      if (requestEpoch !== imageCatalogRequestEpoch) return;
      const providerReady = catalog.providers.some((provider) => (
        provider.providerId === providerId && provider.state === "ready"
      ));
      if (!providerReady) {
        imageGenerationUnavailableReason.value = "图片模型供应商不可用";
        return;
      }
      const modelAvailable = catalog.items.some((item) => (
        item.id === providerId
        && item.value === modelValue
        && item.type === "image"
        && item.disabled !== true
      ));
      // 中文注释：只有当前账号目录确认可用的真实图片 provider/model 才能解锁图片生成。
      if (!modelAvailable) {
        imageGenerationUnavailableReason.value = "图片模型不可用";
        return;
      }
      validatedImageProviderModel.value = configuredProviderModel;
      imageGenerationUnavailableReason.value = "";
    } catch {
      // 目录失败时保持 fail-closed，禁止用任意非空字符串冒充图片能力。
      if (requestEpoch === imageCatalogRequestEpoch) {
        imageGenerationUnavailableReason.value = "图片模型目录加载失败";
      }
    }
  },
  { immediate: true },
);
</script>

<style lang="scss" src="./styles/storyboard-workspace.scss"></style>

<template>
  <aside
    class="storyboardDetail"
    data-panel="shot-production"
    :data-selected-shot="shot?.shotUuid || ''"
    aria-label="当前分镜生产面板"
  >
    <template v-if="shot">
      <header class="detailHeader">
        <div>
          <span class="detailHeader__eyebrow">CURRENT SHOT</span>
          <h2>镜头 {{ shotNumber }}</h2>
          <p>{{ readonly ? "当前为只读访问" : "视频预览、生成参数与候选结果" }}</p>
        </div>
        <span class="detailHeader__duration">{{ durationSeconds }}s</span>
      </header>

      <div class="detailScroll">
        <section class="detailSection" data-section="video-preview">
          <div class="detailSection__title">
            <span>01</span><div><strong>视频预览</strong><small>查看当前镜头已采用或选中的视频</small></div>
          </div>
          <ShotCandidateStrip
            :project-uuid="projectUuid"
            media-type="video"
            :candidates="shot.candidates"
            :readonly="writeActionDisabled"
            :busy="candidateBusy"
            @select="requestSelectCandidate"
          />
        </section>

        <section class="detailSection" data-section="generation-control">
          <div class="detailSection__title">
            <span>02</span><div><strong>生成参数</strong><small>按当前镜头参数提交所选视频模型</small></div>
          </div>
          <label class="fieldGroup">
            <span>分镜提示词</span>
            <textarea
              ref="promptEl"
              v-model="videoPrompt"
              name="videoPrompt"
              rows="4"
              data-prompt-auto-height="true"
              :data-height-scale="String(promptHeightScale)"
              :disabled="editingDisabled"
              placeholder="动作、运镜、节奏和持续时间"
              @focus="onPromptFocus"
              @blur="onPromptBlur"
              @input="syncPromptHeight"
            />
          </label>
          <label class="fieldGroup">
            <span>运镜</span>
            <input v-model="cameraMovement" name="cameraMovement" :disabled="editingDisabled" />
          </label>
          <label class="fieldGroup">
            <span>时代背景</span>
            <input v-model="era" name="era" :disabled="editingDisabled" />
          </label>
          <StoryboardGenerationSettings
            :model-value="generationDraft"
            :readonly="editingDisabled"
            :busy="generationBusy || saving"
            :has-bound-assets="hasBoundAssets"
            :preferred-provider-model="generationSettings.providerModel"
            @update:model-value="handleGenerationSettingsChange"
            @update:catalog-valid="videoCatalogValid = $event"
          />
          <div class="detailGenerationActions">
            <button
              type="button"
              class="detailPreviewButton"
              data-action="preview-shot-video"
              :disabled="readonly || generationBusy || previewBusy || hasUnsavedContent || !videoModelReady"
              @click="previewGeneration"
            >
              {{ previewBusy ? "预览中…" : "预览最终请求" }}
            </button>
            <button
              type="button"
              class="detailGenerateButton"
              data-action="submit-current-shot"
              :disabled="readonly || generationBusy || hasUnsavedContent || !previewMatchesCurrent || !videoModelReady"
              @click="requestGeneration"
            >
              {{ generationBusy ? `正在提交分镜 ${shotNumber}…` : `提交当前分镜 ${shotNumber}` }}
            </button>
          </div>
          <p v-if="generationGuardStatus" data-preview-status class="detailPreviewStatus">{{ generationGuardStatus }}</p>
        </section>

        <section class="detailSection" data-section="candidate-results">
          <div class="detailSection__title">
            <span>03</span><div><strong>视频候选</strong><small>采用现有生成候选，不创建第二套结果模型</small></div>
          </div>
          <div class="detailCandidateGroups">
            <section
              v-for="mediaType in candidateMediaTypes"
              :key="mediaType"
              class="detailCandidateGroup"
              :data-candidate-group="mediaType"
            >
              <header>视频候选</header>
              <ShotCandidateStrip
                :project-uuid="projectUuid"
                :media-type="mediaType"
                :candidates="shot.candidates"
                :readonly="writeActionDisabled"
                :busy="candidateBusy"
                @select="requestSelectCandidate"
              />
            </section>
          </div>
        </section>

        <FinalRequestPreview :request="generationPreview" />
      </div>

      <footer class="detailFooter">
        <div v-if="feedback" :class="['detailFeedback', saveError ? 'is-error' : 'is-success']" role="status">
          <t-icon :name="saveError ? 'error-circle' : 'check-circle'" />{{ feedback }}
        </div>
        <t-button theme="primary" data-action="save-shot" :loading="saving" :disabled="editingDisabled" @click="save">
          <template #icon><t-icon name="save" /></template>保存分镜
        </t-button>
      </footer>
    </template>

    <div v-else class="detailEmpty">
      <span><t-icon name="edit-2" /></span>
      <strong>选择一个镜头开始制作</strong>
      <p>在左侧勾选或点选分镜后，这里会显示预览、生成参数和候选视频。</p>
    </div>
  </aside>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import FinalRequestPreview from "./FinalRequestPreview.vue";
import ShotCandidateStrip from "./ShotCandidateStrip.vue";
import StoryboardGenerationSettings, { type StoryboardGenerationSettingsValue } from "./StoryboardGenerationSettings.vue";
import type { WorkspaceShot } from "../storyboard-workbench-types";
import {
  readSafeGenerationPreviewError,
  requestStoryboardGenerationPreview,
  resolvedStoryboardGenerationMode,
  type SafeStoryboardGenerationPreview,
} from "../storyboard-generation-preview";
import { createStoryboardClientOperationId } from "../storyboard-client-operation";

const props = defineProps<{
  shot: WorkspaceShot | null;
  projectUuid: string;
  videoModels?: readonly { value: string; label: string }[];
  generationSettings: StoryboardGenerationSettingsValue;
  generationSettingsBlocked?: boolean;
  readonly?: boolean;
  generationBusy?: boolean;
  candidateBusy?: boolean;
}>();
const emit = defineEmits<{
  saved: [];
  dirtyChange: [{ shotUuid: string; dirty: boolean }];
  pickAsset: [{ shotUuid: string; assetType: "role" | "scene" | "tool" }];
  selectCandidate: [{ shotUuid: string; candidateUuid: string }];
  generationSettingsChange: [StoryboardGenerationSettingsValue];
  generate: [{
    shotUuid: string;
    settings: StoryboardGenerationSettingsValue & {
      expectedPreviewDigest: string;
      clientOperationId: string;
      routeKind: SafeStoryboardGenerationPreview["routeKind"];
    };
  }];
}>();

const sourceText = ref("");
const visualDescription = ref("");
const imagePrompt = ref("");
const videoPrompt = ref("");
const negativePrompt = ref("");
const shotSize = ref("");
const cameraMovement = ref("");
const composition = ref("");
const era = ref("");
const durationSeconds = ref(5);
const aspectRatio = ref("9:16");
const saving = ref(false);
const feedback = ref("");
const saveError = ref(false);
const generationDraft = ref<StoryboardGenerationSettingsValue>({ ...props.generationSettings });
const generationPreview = ref<SafeStoryboardGenerationPreview | null>(null);
const previewFingerprint = ref("");
const previewStatus = ref("");
const previewBusy = ref(false);
const promptEl = ref<HTMLTextAreaElement | null>(null);
const promptFocused = ref(false);
const promptHeightScale = ref(1);
const generationOperationId = ref("");
const generationOperationFingerprint = ref("");
const persistedContentFingerprint = ref("");
const candidateMediaTypes = ["video"] as const;

const shotNumber = computed(() => String(props.shot?.displayOrder ?? 0).padStart(2, "0"));
const editableContentFingerprint = computed(() => JSON.stringify({
  shotUuid: props.shot?.shotUuid ?? "",
  sourceText: sourceText.value,
  visualDescription: visualDescription.value,
  imagePrompt: imagePrompt.value,
  videoPrompt: videoPrompt.value,
  negativePrompt: negativePrompt.value,
  shotSize: shotSize.value,
  cameraMovement: cameraMovement.value,
  composition: composition.value,
  era: era.value,
  aspectRatio: aspectRatio.value,
}));
const hasUnsavedContent = computed(() => Boolean(
  props.shot && persistedContentFingerprint.value !== editableContentFingerprint.value,
));
const editingDisabled = computed(() => Boolean(props.readonly || saving.value));
const writeActionDisabled = computed(() => Boolean(editingDisabled.value || hasUnsavedContent.value));
const generationGuardStatus = computed(() => (
  hasUnsavedContent.value ? "请先保存分镜内容" : previewStatus.value
));
const currentPreviewFingerprint = computed(() => JSON.stringify({
  // 中文注释：项目身份是服务端预览上下文的一部分；切换项目后旧预览必须立即失效。
  projectUuid: props.projectUuid,
  shotUuid: props.shot?.shotUuid ?? "",
  providerModel: generationDraft.value.providerModel,
  mode: generationDraft.value.mode,
  resolution: generationDraft.value.resolution,
  aspectRatio: generationDraft.value.aspectRatio,
  durationMs: generationDraft.value.durationMs,
  visualDescription: visualDescription.value,
  videoPrompt: videoPrompt.value,
  negativePrompt: negativePrompt.value,
  bindings: (props.shot?.bindings ?? []).map((binding) => ({
    sourceProjectUuid: binding.sourceProjectUuid,
    assetUuid: binding.assetUuid,
    assetType: binding.assetType,
    voiceEnabled: binding.voiceEnabled !== false,
  })),
}));
const previewMatchesCurrent = computed(() => Boolean(
  generationPreview.value && previewFingerprint.value === currentPreviewFingerprint.value,
));
const hasBoundAssets = computed(() => (
  (props.shot?.bindings ?? []).some((binding) => ["role", "scene", "tool"].includes(binding.assetType))
));
const videoCatalogValid = ref(false);
const videoModelReady = computed(() => (
  videoCatalogValid.value && !props.generationSettingsBlocked
));

watch(
  () => props.shot,
  (shot, previousShot) => {
    // 中文注释：同一镜头的远端刷新不得覆盖尚未保存的本地草稿；保存成功后才接受新 DTO。
    if (
      shot?.shotUuid
      && shot.shotUuid === previousShot?.shotUuid
      && hasUnsavedContent.value
    ) return;
    sourceText.value = shot?.sourceText ?? "";
    visualDescription.value = shot?.visualDescription ?? "";
    imagePrompt.value = shot?.imagePrompt ?? "";
    videoPrompt.value = shot?.videoPrompt ?? "";
    negativePrompt.value = shot?.negativePrompt ?? "";
    shotSize.value = shot?.shotSize ?? "";
    cameraMovement.value = shot?.cameraMovement ?? "";
    composition.value = shot?.composition ?? "";
    era.value = shot?.era ?? "";
    durationSeconds.value = Math.round(Number(shot?.durationMs ?? 5000) / 1000);
    aspectRatio.value = shot?.aspectRatio ?? "9:16";
    generationDraft.value = {
      // 中文注释：换镜头只更新镜头自身时长和画幅，当前用户显式模型/模式继续作为唯一真源。
      ...generationDraft.value,
      durationMs: Math.max(500, Number(shot?.durationMs ?? props.generationSettings.durationMs ?? 5000)),
      aspectRatio: shot?.aspectRatio ?? props.generationSettings.aspectRatio ?? "9:16",
    };
    feedback.value = "";
    saveError.value = false;
    generationPreview.value = null;
    generationOperationId.value = "";
    generationOperationFingerprint.value = "";
    previewFingerprint.value = "";
    previewStatus.value = "";
    persistedContentFingerprint.value = editableContentFingerprint.value;
    promptFocused.value = false;
    void syncPromptHeight();
  },
  { immediate: true },
);

function handleGenerationSettingsChange(settings: StoryboardGenerationSettingsValue): void {
  // 中文注释：子面板的显式选择同时提升为工作区当前设置，父 DTO 刷新不得再覆盖本地草稿。
  generationDraft.value = { ...settings };
  emit("generationSettingsChange", { ...settings });
}

watch(() => generationDraft.value.durationMs, (durationMs) => {
  const seconds = Math.round(Number(durationMs || 5000) / 1000);
  if (seconds !== durationSeconds.value) durationSeconds.value = seconds;
});

watch(currentPreviewFingerprint, (next, previous) => {
  if (!previous || !previewFingerprint.value || next === previewFingerprint.value) return;
  generationPreview.value = null;
  generationOperationId.value = "";
  generationOperationFingerprint.value = "";
  previewFingerprint.value = "";
  previewStatus.value = "参数已变化，请重新预览";
});

watch(hasUnsavedContent, (dirty) => {
  const shotUuid = props.shot?.shotUuid ?? "";
  if (shotUuid) emit("dirtyChange", { shotUuid, dirty });
}, { immediate: true });

function readDetailPromptBaseHeight(): number {
  const raw = getComputedStyle(promptEl.value ?? document.documentElement)
    .getPropertyValue("--shot-detail-prompt-base-height");
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 96;
}

async function syncPromptHeight(): Promise<void> {
  await nextTick();
  const element = promptEl.value;
  if (!element) return;
  // 中文注释：失焦必须精确回到基础高度；聚焦至少 2 倍，输入最多 3 倍后内部滚动。
  const base = readDetailPromptBaseHeight();
  if (!promptFocused.value) {
    element.style.height = `${base}px`;
    promptHeightScale.value = 1;
    return;
  }
  const minHeight = base * 2;
  const maxHeight = base * 3;
  element.style.height = `${minHeight}px`;
  const nextHeight = Math.min(maxHeight, Math.max(minHeight, element.scrollHeight || minHeight));
  element.style.height = `${nextHeight}px`;
  promptHeightScale.value = Math.round((nextHeight / base) * 10) / 10;
}

function onPromptFocus(): void {
  promptFocused.value = true;
  void syncPromptHeight();
}

function onPromptBlur(): void {
  promptFocused.value = false;
  void syncPromptHeight();
}

function requestSelectCandidate(candidateUuid: string): void {
  if (!props.shot?.shotUuid || !candidateUuid || props.readonly || props.candidateBusy) return;
  emit("selectCandidate", { shotUuid: props.shot.shotUuid, candidateUuid });
}

function previewInput() {
  if (!props.shot) return null;
  const durationMs = Number(generationDraft.value.durationMs ?? props.shot.durationMs ?? 5000);
  const requestedAspectRatio = String(generationDraft.value.aspectRatio ?? props.shot.aspectRatio ?? "9:16");
  return {
    shotUuid: props.shot.shotUuid,
    mediaType: "video" as const,
    providerModel: generationDraft.value.providerModel,
    // auto 必须原样交给服务端结合绑定素材解析，前端不能提前猜成 text2video。
    mode: generationDraft.value.mode,
    // 中文注释：预览与正式提交共用抽屉内当前明确选择的分辨率。
    resolution: generationDraft.value.resolution,
    durationMs,
    aspectRatio: requestedAspectRatio,
    shot: {
      visualDescription: visualDescription.value,
      videoPrompt: videoPrompt.value,
      negativePrompt: negativePrompt.value,
      durationMs,
      aspectRatio: requestedAspectRatio,
    },
  };
}

async function previewGeneration(): Promise<void> {
  const input = previewInput();
  if (!input || !props.projectUuid || props.readonly || props.generationBusy || previewBusy.value) return;
  if (props.generationSettingsBlocked) {
    // 中文注释：模型选择尚未保存或保存失败时，禁止用旧项目默认值发起预览。
    previewStatus.value = "视频模型保存失败，请重试";
    return;
  }
  // 中文注释：handler 再判一次目录有效状态，禁止只靠按钮 disabled 被 trigger 绕过。
  if (!videoModelReady.value) {
    previewStatus.value = "当前账号未配置可用视频模型";
    return;
  }
  if (hasUnsavedContent.value) {
    previewStatus.value = "请先保存分镜内容";
    return;
  }
  previewBusy.value = true;
  previewStatus.value = "";
  generationPreview.value = null;
  previewFingerprint.value = "";
  const fingerprint = currentPreviewFingerprint.value;
  try {
    const preview = await requestStoryboardGenerationPreview(props.projectUuid, input);
    if (props.readonly) {
      // 中文注释：服务端预览等待期间降为只读时丢弃旧响应，不能用它解锁收费操作。
      previewStatus.value = "项目权限已变化，已取消预览";
      return;
    }
    // 请求返回期间参数变化时丢弃旧响应，禁止旧预览解锁新参数的收费提交。
    if (fingerprint !== currentPreviewFingerprint.value) {
      previewStatus.value = "参数已变化，请重新预览";
      return;
    }
    generationPreview.value = preview;
    const operationFingerprint = JSON.stringify({
      projectUuid: props.projectUuid,
      input,
      preview: {
        previewDigest: preview.previewDigest,
        providerModel: preview.providerModel,
        routeKind: preview.routeKind,
        prompt: preview.prompt,
        options: Object.fromEntries(
          Object.entries(preview.options).sort(([left], [right]) => left.localeCompare(right)),
        ),
      },
    });
    // 中文注释：相同规范化输入和服务端摘要属于同一不确定收费意图，重新预览也必须复用原 ID。
    if (generationOperationFingerprint.value !== operationFingerprint) {
      generationOperationId.value = createStoryboardClientOperationId();
      generationOperationFingerprint.value = operationFingerprint;
    }
    previewFingerprint.value = fingerprint;
    previewStatus.value = "预览已就绪";
  } catch (error) {
    previewStatus.value = readSafeGenerationPreviewError(error, "生成预览失败，请重试");
  } finally {
    previewBusy.value = false;
  }
}

function requestGeneration(): void {
  if (
    !props.shot?.shotUuid
    || props.readonly
    || props.generationBusy
    || hasUnsavedContent.value
    || !previewMatchesCurrent.value
    || !generationPreview.value
    || !generationOperationId.value
    || !videoModelReady.value
  ) return;
  try {
    const mode = resolvedStoryboardGenerationMode(generationPreview.value, "video");
    // 中文注释：正式收费请求只使用已展示的服务端显式模式，绝不把 auto 直接提交。
    emit("generate", {
      shotUuid: props.shot.shotUuid,
      settings: {
        ...generationDraft.value,
        mode,
        routeKind: generationPreview.value.routeKind,
        expectedPreviewDigest: generationPreview.value.previewDigest,
        clientOperationId: generationOperationId.value,
      } as StoryboardGenerationSettingsValue & {
        expectedPreviewDigest: string;
        clientOperationId: string;
        routeKind: SafeStoryboardGenerationPreview["routeKind"];
      },
    });
  } catch {
    previewStatus.value = "生成预览已失效，请重新预览";
  }
}

async function save() {
  if (!props.shot?.shotUuid || !props.projectUuid || saving.value || props.readonly) return;
  saving.value = true;
  feedback.value = "";
  saveError.value = false;
  const submittedFingerprint = editableContentFingerprint.value;
  // 中文注释：冻结发送载荷；响应只能确认这一快照，不能把请求期间出现的新草稿误标为已保存。
  const submittedPayload = {
    sourceText: sourceText.value,
    visualDescription: visualDescription.value,
    imagePrompt: imagePrompt.value,
    videoPrompt: videoPrompt.value,
    negativePrompt: negativePrompt.value,
    shotSize: shotSize.value,
    cameraMovement: cameraMovement.value,
    composition: composition.value,
    era: era.value,
    durationMs: Math.round(Number(durationSeconds.value) * 1000),
    aspectRatio: aspectRatio.value,
  };
  try {
    await axios.patch(
      `/tianjiang/runtime/projects/${encodeURIComponent(props.projectUuid)}/storyboard/shots/${encodeURIComponent(props.shot.shotUuid)}`,
      submittedPayload,
    );
    persistedContentFingerprint.value = submittedFingerprint;
    previewStatus.value = "";
    if (editableContentFingerprint.value === submittedFingerprint) {
      feedback.value = "分镜已保存";
      emit("saved");
    } else {
      feedback.value = "已保存请求快照，检测到新修改，请再次保存";
      previewStatus.value = "请先保存分镜内容";
    }
  } catch {
    saveError.value = true;
    feedback.value = "保存分镜失败，请重试";
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped lang="scss">
.detailAssetActions,
.detailCandidateGroups {
  display: grid;
  gap: 10px;
}

.detailAssetActions {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.detailAssetActions button,
.detailCandidateGroup,
.detailGenerateButton {
  color: var(--product-text);
  background: var(--product-surface-soft);
  border: 1px solid var(--product-border);
  border-radius: 10px;
}

.detailAssetActions button {
  display: grid;
  gap: 4px;
  padding: 10px;
  text-align: left;
}

.detailAssetActions small,
.detailCandidates__empty {
  color: var(--product-text-muted);
}

.detailCandidateGroup {
  display: grid;
  gap: 8px;
  padding: 10px;
}

.detailCandidateGroup > header {
  color: var(--product-text-secondary);
  font-size: 11px;
  font-weight: 600;
}

.detailGenerateButton {
  min-height: 36px;
  padding: 0 12px;
}

.detailGenerationActions {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
  gap: 8px;
  margin-top: 10px;
}

.detailPreviewButton,
.detailGenerateButton {
  width: 100%;
  color: var(--td-text-color-anti);
  background: var(--td-brand-color);
  border-color: var(--td-brand-color);
}

.detailPreviewButton {
  color: var(--product-text);
  background: var(--product-surface-soft);
  border: 1px solid var(--product-border-strong);
  border-radius: 10px;
}

.detailPreviewStatus {
  margin: 8px 0 0;
  color: var(--product-text-muted);
  font-size: 10px;
}

.detailPreviewButton:disabled,
.detailGenerateButton:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.detailAssetActions button:focus-visible,
.detailGenerateButton:focus-visible {
  outline: none;
  box-shadow: var(--product-focus-ring);
}

@media (max-width: 760px) {
  .detailAssetActions {
    grid-template-columns: 1fr;
  }
}
</style>

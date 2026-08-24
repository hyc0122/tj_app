<template>
  <section class="settingsWorkspace" data-panel="storyboard-settings">
    <header class="moduleHero"><div><span>PROJECT SETTINGS</span><h2>分镜设置</h2><p>统一项目画幅、默认镜头时长和全局生成风格。</p></div><t-button theme="primary" :loading="saving" :disabled="readonly" data-action="save-storyboard-settings" @click="save"><template #icon><t-icon name="save" /></template>保存设置</t-button></header>
    <div v-if="feedback" :class="['storyboardFeedback', saveError ? 'is-error' : 'is-success']" role="status"><t-icon :name="saveError ? 'error-circle' : 'check-circle'" />{{ feedback }}</div>
    <div class="settingsGrid">
      <div class="settingsForm">
        <section class="settingsCard"><header><span>01</span><div><strong>画面规格</strong><small>应用于新建镜头与生成请求</small></div></header><div class="fieldGrid"><label class="fieldGroup"><span>默认画幅</span><select v-model="aspectRatio" :disabled="readonly"><option>9:16</option><option>16:9</option><option>1:1</option><option>4:3</option></select></label><label class="fieldGroup"><span>默认时长（秒）</span><input v-model.number="defaultDurationSeconds" name="durationSeconds" type="number" min="4" max="30" step="1" :disabled="readonly" /></label></div></section>
        <section class="settingsCard"><header><span>02</span><div><strong>全局图片风格</strong><small>叠加在单镜头图片提示词之前</small></div></header><label class="fieldGroup"><span>图片提示词</span><textarea v-model="globalImagePrompt" name="globalImagePrompt" rows="6" :disabled="readonly" placeholder="例如：电影级光影、统一人物造型、细腻材质" /></label></section>
        <section class="settingsCard"><header><span>03</span><div><strong>视频风格与指令模板</strong><small>下拉选择视频指令模板；&#123;&#123;style&#125;&#125; 只替换为项目小说类型</small></div></header>
          <label class="fieldGroup"><span>指令模板</span>
            <select v-model="currentTemplateId" name="videoPromptTemplateId" :disabled="readonly" @change="onTemplateSelect">
              <option :value="null">未选择模板</option>
              <option v-for="item in videoTemplates" :key="item.id" :value="item.id">{{ item.name }}</option>
            </select>
          </label>
          <pre class="settingsHint" data-field="video-template-content">{{ selectedTemplateContent || "未选择模板内容" }}</pre>
          <p class="settingsHint" data-field="current-video-template">当前模板：{{ currentTemplateName || "未选择模板" }}</p>
          <t-button variant="outline" data-action="open-video-template-manager" @click="templateOpen = true">管理视频指令模板</t-button>
          <label class="fieldGroup"><span>全局视频提示词</span>
            <textarea v-model="globalVideoPrompt" name="globalVideoPrompt" rows="4" :disabled="readonly" placeholder="仅保存在项目设置中；与上方指令模板共同组成最终请求。" />
          </label>
        </section>
    <StoryboardVideoTemplateDialog :open="templateOpen" :project-uuid="projectUuid" :readonly="readonly" @close="templateOpen = false" @applied="reload" />
      </div>
      <div class="settingsPreview">
        <FinalRequestPreview :request="generationPreview" />
        <button type="button" data-action="preview-storyboard-settings" :disabled="previewDisabled" @click="previewSettings">
          {{ previewing ? "预览中…" : "请求服务端最终预览" }}
        </button>
        <p v-if="previewStatus" data-preview-status="settings">{{ previewStatus }}</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import FinalRequestPreview from "./FinalRequestPreview.vue";
import StoryboardVideoTemplateDialog from "./StoryboardVideoTemplateDialog.vue";
import { buildStoryboardSettingsUrl } from "./storyboardSettingsUrl";
import {
  requestStoryboardGenerationPreview,
  type SafeStoryboardGenerationPreview,
} from "../storyboard-generation-preview";

const props = withDefaults(defineProps<{
  projectUuid?: string;
  readonly?: boolean;
  providerModel?: string;
  selectedShotUuid?: string;
}>(), {
  projectUuid: "",
  readonly: false,
  providerModel: "dreamina-cli:seedance2.0fast",
  selectedShotUuid: "",
});
const aspectRatio = ref("9:16");
const defaultDurationSeconds = ref(5);
const globalImagePrompt = ref("");
const globalVideoPrompt = ref("");
const videoTemplates = ref<Array<{ id: number; name: string; content?: string }>>([]);
const currentTemplateId = ref<number | null>(null);
const selectedTemplateContent = ref("");
const templateOpen = ref(false);
const saving = ref(false);
const feedback = ref("");
const saveError = ref(false);
const generationPreview = ref<SafeStoryboardGenerationPreview | null>(null);
const previewFingerprint = ref("");
const previewStatus = ref("");
const previewing = ref(false);
const settingsHydrated = ref(false);
let reloadPromise: Promise<void> | null = null;
const savedSettings = ref({
  aspectRatio: "9:16",
  durationMs: 5000,
  globalImagePrompt: "",
  globalVideoPrompt: "",
  videoPromptTemplateId: null as number | null,
  videoPromptTemplateContent: "",
});

function currentFormSettings() {
  return {
    aspectRatio: aspectRatio.value,
    durationMs: Math.round(defaultDurationSeconds.value * 1000),
    globalImagePrompt: globalImagePrompt.value,
    globalVideoPrompt: globalVideoPrompt.value,
    videoPromptTemplateId: currentTemplateId.value,
    videoPromptTemplateContent: selectedTemplateContent.value,
  };
}

function isSettingsDirty(): boolean {
  return JSON.stringify(currentFormSettings()) !== JSON.stringify(savedSettings.value);
}

const previewDisabled = computed(() => previewing.value || !String(props.selectedShotUuid ?? "").trim());

/** 中文注释：已确认预览指纹只跟已保存设置和当前分镜走，禁止纳入未保存 globalVideoPrompt。 */
const currentPreviewFingerprint = computed(() => JSON.stringify({
  providerModel: props.providerModel,
  selectedShotUuid: String(props.selectedShotUuid ?? "").trim(),
  ...savedSettings.value,
}));

function runtimeUrl(): string {
  return buildStoryboardSettingsUrl(props.projectUuid);
}

/** 中文注释：全局 Axios 已解包为 { code, data }，设置页不能再二次解包。 */
function readRuntimeData<T>(payload: unknown): T | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  return (payload as { data?: T }).data;
}

async function reload() {
  if (!props.projectUuid) return;
  if (reloadPromise) return reloadPromise;
  reloadPromise = (async () => {
    try {
      const payload = readRuntimeData<Record<string, unknown>>(await axios.get(runtimeUrl())) ?? {};
      aspectRatio.value = String(payload.aspectRatio ?? aspectRatio.value);
      const durationMs = Number(payload.durationMs);
      defaultDurationSeconds.value = Number.isFinite(durationMs) && durationMs > 0
        ? durationMs / 1000
        : defaultDurationSeconds.value;
      globalImagePrompt.value = String(payload.globalImagePrompt ?? "");
      globalVideoPrompt.value = String(payload.globalVideoPrompt ?? "");
      const templateId = Number(payload.videoPromptTemplateId);
      currentTemplateId.value = Number.isInteger(templateId) && templateId > 0 ? templateId : null;
      selectedTemplateContent.value = String(payload.videoPromptTemplateContent ?? "");
      try {
        const templates = readRuntimeData<{ templates?: Array<{ id: number; name: string; content?: string }> }>(
          await axios.get(`/tianjiang/runtime/projects/${encodeURIComponent(props.projectUuid)}/storyboard/video-templates`),
        );
        videoTemplates.value = Array.isArray(templates?.templates) ? templates.templates : [];
        const current = videoTemplates.value.find((item) => item.id === currentTemplateId.value);
        if (current) selectedTemplateContent.value = String(current.content ?? "");
      } catch {
        videoTemplates.value = [];
      }
      savedSettings.value = currentFormSettings();
      settingsHydrated.value = true;
      generationPreview.value = null;
      previewFingerprint.value = "";
      previewStatus.value = String(props.selectedShotUuid ?? "").trim() ? "" : "当前没有可预览的分镜";
    } catch {
      // 首屏设置读取失败时保留可用默认值，保存动作会给出明确错误。
    }
  })().finally(() => {
    reloadPromise = null;
  });
  return reloadPromise;
}

async function save() {
  if (!props.projectUuid || props.readonly) return;
  saving.value = true;
  feedback.value = "";
  saveError.value = false;
  try {
    await axios.put(runtimeUrl(), {
      aspectRatio: aspectRatio.value,
      durationMs: Math.round(defaultDurationSeconds.value * 1000),
      globalImagePrompt: globalImagePrompt.value,
      globalVideoPrompt: globalVideoPrompt.value,
      videoPromptTemplateId: currentTemplateId.value,
      videoPromptTemplateContent: selectedTemplateContent.value,
    });
    await reload();
    feedback.value = "项目分镜设置已保存";
  } catch {
    saveError.value = true;
    feedback.value = "保存设置失败，请重试";
  } finally {
    saving.value = false;
  }
}

watch(currentPreviewFingerprint, (next, previous) => {
  if (!previous || !previewFingerprint.value || next === previewFingerprint.value) return;
  generationPreview.value = null;
  previewFingerprint.value = "";
  previewStatus.value = "参数已变化，请重新预览";
});

async function previewSettings(): Promise<void> {
  if (!props.projectUuid || previewing.value) return;
  const shotUuid = String(props.selectedShotUuid ?? "").trim();
  if (!shotUuid) {
    previewStatus.value = "当前没有可预览的分镜";
    generationPreview.value = null;
    return;
  }
  // 中文注释：真实 HTTP 下首屏 GET 未完成时不能把加载中当成脏表单，必须等已保存快照落盘。
  if (!settingsHydrated.value) await reload();
  if (isSettingsDirty()) {
    previewStatus.value = "请先保存设置再预览";
    generationPreview.value = null;
    return;
  }
  previewing.value = true;
  generationPreview.value = null;
  previewFingerprint.value = "";
  previewStatus.value = "";
  const fingerprint = currentPreviewFingerprint.value;
  const durationMs = savedSettings.value.durationMs;
  try {
    const preview = await requestStoryboardGenerationPreview(props.projectUuid, {
      shotUuid,
      mediaType: "video",
      providerModel: props.providerModel,
      mode: "auto",
      aspectRatio: savedSettings.value.aspectRatio,
      durationMs,
      shot: { aspectRatio: savedSettings.value.aspectRatio, durationMs },
    });
    if (fingerprint !== currentPreviewFingerprint.value) {
      previewStatus.value = "参数已变化，请重新预览";
      return;
    }
    generationPreview.value = preview;
    previewFingerprint.value = fingerprint;
    previewStatus.value = "预览已就绪";
  } catch {
    previewStatus.value = "生成预览失败，请重试";
  } finally {
    previewing.value = false;
  }
}

const currentTemplateName = computed(() => (
  videoTemplates.value.find((item) => item.id === currentTemplateId.value)?.name ?? ""
));

function onTemplateSelect(): void {
  const id = Number(currentTemplateId.value);
  currentTemplateId.value = Number.isInteger(id) && id > 0 ? id : null;
  const current = videoTemplates.value.find((item) => item.id === currentTemplateId.value);
  selectedTemplateContent.value = String(current?.content ?? "");
}

watch(() => props.selectedShotUuid, (shotUuid) => {
  if (String(shotUuid ?? "").trim()) return;
  generationPreview.value = null;
  previewFingerprint.value = "";
  previewStatus.value = "当前没有可预览的分镜";
});

onMounted(() => { void reload(); });
</script>

<style scoped lang="scss">
.settingsPreview {
  display: grid;
  gap: 10px;
  align-content: start;
}

.settingsPreview > button {
  min-height: 36px;
  color: var(--td-text-color-anti);
  background: var(--td-brand-color);
  border: 1px solid var(--td-brand-color);
  border-radius: 9px;
}

.settingsPreview > button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.settingsPreview > p,
.settingsHint {
  margin: 0;
  color: var(--product-text-muted);
  font-size: 10px;
}
</style>

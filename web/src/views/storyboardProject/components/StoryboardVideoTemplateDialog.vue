<template>
  <section v-if="open" data-dialog="storyboard-video-template">
    <t-dialog
      :visible="open"
      header="视频指令模板"
      attach="body"
      placement="center"
      dialog-class-name="storyboardVideoTemplateDialog"
      width="min(1080px, calc(100vw - 48px))"
      @close="emit('close')"
    >
      <div class="templateManager">
        <aside>
          <button type="button" data-action="create-video-template" :disabled="readonly" @click="startCreate">新建模板</button>
          <p class="templateHint">资产图片生成模板与视频指令模板互不冲突。变量来源说明不会进入最终请求。</p>
          <strong>视频指令模板</strong>
          <button
            v-for="item in systemTemplates"
            :key="item.id"
            type="button"
            :data-template-id="item.id"
            :class="{ active: selectedId === item.id && !creating }"
            @click="selectTemplate(item)"
          >{{ item.name }}</button>
          <strong>我的指令</strong>
          <button
            v-for="item in userTemplates"
            :key="item.id"
            type="button"
            :data-template-id="item.id"
            :class="{ active: selectedId === item.id && !creating }"
            @click="selectTemplate(item)"
          >{{ item.name }}</button>
        </aside>
        <div>
          <input v-model="name" name="templateName" :disabled="readonly || currentSystem" placeholder="提示词模板名称" />
          <div class="variableButtons">
            <button
              v-for="variable in variables"
              :key="variable"
              type="button"
              :disabled="readonly || currentSystem"
              @click="insertVariable(variable)"
            >{{ variable }}</button>
          </div>
          <div class="variableHelp">
            <p>变量来源说明</p>
            <p v-for="variable in variables" :key="variable">
              <code>{{ variable }}</code>：{{ help[variable] }}
            </p>
          </div>
          <textarea
            id="storyboard-video-template-content"
            v-model="content"
            name="templateContent"
            rows="12"
            :disabled="readonly || currentSystem"
          />
          <p v-if="feedback" role="status">{{ feedback }}</p>
        </div>
      </div>
      <template #footer>
        <t-button variant="outline" @click="emit('close')">关闭</t-button>
        <t-button data-action="save-video-template" :disabled="readonly || currentSystem || saving" @click="save(false)">仅保存</t-button>
        <t-button theme="primary" data-action="save-and-use-video-template" :disabled="readonly || saving" @click="save(true)">保存并用于当前项目</t-button>
      </template>
    </t-dialog>
  </section>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";

const DEFAULT_TEMPLATE = [
  "全局前置提示词：",
  "风格：{{style}}。",
  "镜头语言：{{camera}}。",
  "时代背景：{{era}}。",
  "角色：{{roles}}。",
  "场景：{{scene}}。",
  "道具：{{props}}。",
  "",
  "{{shot_prompt}}",
].join("\n");

const variables = ["{{style}}", "{{camera}}", "{{era}}", "{{roles}}", "{{scene}}", "{{props}}", "{{shot_prompt}}"];
const help: Record<string, string> = {
  "{{style}}": "当前项目已保存的小说类型；没有则为空。",
  "{{camera}}": "当前分镜镜头语言；没有则为空。",
  "{{era}}": "当前分镜时代背景；没有则为空。",
  "{{roles}}": "当前分镜已绑定角色的名称和描述。",
  "{{scene}}": "当前分镜已绑定场景的名称和描述。",
  "{{props}}": "当前分镜已绑定道具的名称和描述。",
  "{{shot_prompt}}": "当前分镜自己的分镜提示词。",
};

interface TemplateRow {
  id: number;
  name: string;
  type: string;
  content: string;
  system?: boolean;
}

const props = defineProps<{
  open: boolean;
  projectUuid: string;
  readonly?: boolean;
}>();
const emit = defineEmits<{
  close: [];
  applied: [];
}>();

const templates = ref<TemplateRow[]>([]);
const selectedId = ref<number | null>(null);
const creating = ref(false);
const name = ref("");
const content = ref(DEFAULT_TEMPLATE);
const saving = ref(false);
const feedback = ref("");

const systemTemplates = computed(() => templates.value.filter((item) => item.system || item.type === "storyboardVideoSystemTemplate"));
const userTemplates = computed(() => templates.value.filter((item) => !item.system && item.type === "storyboardVideoUserTemplate"));
const currentSystem = computed(() => !creating.value && systemTemplates.value.some((item) => item.id === selectedId.value));

function templateUrl(suffix = ""): string {
  return `/tianjiang/runtime/projects/${encodeURIComponent(props.projectUuid)}/storyboard/video-templates${suffix}`;
}

/** 中文注释：全局 Axios 拦截器已返回 { code, data, message }，禁止再读 data.data。 */
function readRuntimeData<T>(payload: unknown): T | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  return (payload as { data?: T }).data;
}

async function reload(): Promise<void> {
  const payload = readRuntimeData<{ templates?: TemplateRow[] }>(await axios.get(templateUrl()));
  templates.value = Array.isArray(payload?.templates) ? payload.templates : [];
  const current = templates.value.find((item) => item.id === selectedId.value);
  if (current) {
    selectTemplate(current);
    return;
  }
  if (!selectedId.value && templates.value[0]) selectTemplate(templates.value[0]);
}

function selectTemplate(item: TemplateRow): void {
  creating.value = false;
  selectedId.value = item.id;
  name.value = item.name;
  content.value = item.content;
  feedback.value = "";
}

function startCreate(): void {
  creating.value = true;
  selectedId.value = null;
  name.value = "";
  content.value = DEFAULT_TEMPLATE;
  feedback.value = "";
}

function insertVariable(variable: string): void {
  const textarea = document.getElementById("storyboard-video-template-content") as HTMLTextAreaElement | null;
  const start = textarea?.selectionStart ?? content.value.length;
  const end = textarea?.selectionEnd ?? content.value.length;
  content.value = `${content.value.slice(0, start)}${variable}${content.value.slice(end)}`;
}

async function save(useTemplate: boolean): Promise<void> {
  if (props.readonly) return;
  saving.value = true;
  feedback.value = "";
  try {
    let id = selectedId.value;
    if (creating.value || !id) {
      const created = readRuntimeData<{ id?: number }>(await axios.post(templateUrl(), { name: name.value, content: content.value }));
      id = Number(created?.id);
      if (!Number.isFinite(id) || id <= 0) throw new Error("视频指令模板编号无效");
    } else if (!currentSystem.value) {
      await axios.put(`${templateUrl()}/${encodeURIComponent(String(id))}`, {
        name: name.value,
        content: content.value,
      });
    }
    if (useTemplate && id) {
      await axios.post(`${templateUrl()}/${encodeURIComponent(String(id))}/use`, {});
      feedback.value = "视频生成模板已保存并应用到当前项目";
      emit("applied");
    } else {
      feedback.value = "视频生成模板已保存";
    }
    creating.value = false;
    selectedId.value = id ?? null;
    await reload();
  } catch {
    feedback.value = "保存视频生成模板失败";
  } finally {
    saving.value = false;
  }
}

watch(() => props.open, (open) => {
  if (!open) return;
  void reload().catch(() => {
    templates.value = [];
  });
}, { immediate: true });
</script>

<style scoped lang="scss">
.templateManager {
  display: grid;
  grid-template-columns: minmax(220px, 240px) minmax(0, 1fr);
  gap: 14px;
  min-width: 0;
  overflow-x: hidden;
}

.templateManager aside,
.templateManager > div {
  display: grid;
  gap: 8px;
  align-content: start;
  min-width: 0;
}

.templateHint,
.variableHelp {
  color: var(--product-text-secondary);
  font-size: 12px;
}

.variableButtons {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.templateManager textarea,
.templateManager input {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}

.active {
  border-color: var(--td-brand-color);
}

@media (max-width: 720px) {
  .templateManager {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

<style lang="scss">
/* 中文注释：弹窗 attach 到 body 后，scoped 无法覆盖 TDesign 外壳，必须用专用全局 class。 */
.storyboardVideoTemplateDialog {
  width: min(1080px, calc(100vw - 48px));
  max-width: calc(100vw - 48px);
  max-height: 88vh;
  overflow-x: hidden;
  color: var(--product-text);
  background: var(--product-surface);
}

.t-dialog__ctx.storyboardVideoTemplateDialog .t-dialog,
.storyboardVideoTemplateDialog.t-dialog {
  display: flex;
  flex-direction: column;
  max-height: 88vh;
  overflow-x: hidden;
  color: var(--product-text);
  background: var(--product-surface);
}

.storyboardVideoTemplateDialog .t-dialog__header,
.storyboardVideoTemplateDialog .t-dialog__footer {
  flex-shrink: 0;
}

.storyboardVideoTemplateDialog .t-dialog__body {
  min-height: 0;
  overflow: auto;
  overflow-x: hidden;
  max-height: calc(88vh - 148px);
}

.storyboardVideoTemplateDialog button,
.storyboardVideoTemplateDialog input,
.storyboardVideoTemplateDialog textarea {
  color: var(--product-text);
  background: var(--product-surface-soft);
  border: 1px solid var(--product-border);
  border-radius: 8px;
  padding: 6px 10px;
}

.storyboardVideoTemplateDialog button:disabled,
.storyboardVideoTemplateDialog input:disabled,
.storyboardVideoTemplateDialog textarea:disabled {
  color: var(--product-text-secondary);
  opacity: 0.6;
}

.storyboardVideoTemplateDialog button.active {
  border-color: var(--td-brand-color);
  color: var(--td-brand-color);
}

.storyboardVideoTemplateDialog .templateHint,
.storyboardVideoTemplateDialog .variableHelp,
.storyboardVideoTemplateDialog .variableHelp p {
  color: var(--product-text-secondary);
}

.storyboardVideoTemplateDialog code {
  color: var(--product-text);
  background: var(--product-surface-soft);
  border: 1px solid var(--product-border);
  border-radius: 4px;
  padding: 0 4px;
}

@media (max-width: 720px) {
  .storyboardVideoTemplateDialog .templateManager {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

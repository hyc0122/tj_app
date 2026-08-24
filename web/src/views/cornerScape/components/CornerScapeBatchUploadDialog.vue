<template>
  <t-dialog
    :visible="open"
    data-modal="batch-upload-assets"
    data-dialog="batch-upload-assets"
    header="批量上传资产"
    :footer="false"
    attach="body"
    placement="center"
    width="min(760px, calc(100vw - 32px))"
    dialog-class-name="assetActionGlobalDialog"
    @close="emit('close')"
    @update:visible="onVisible"
  >
    <div class="batchUploadDialog">
      <div class="batchUploadDialog__types" role="group" aria-label="资产类型">
        <button type="button" :class="{ active: type === 'role' }" data-field="batch-asset-type" :disabled="readonly || busy" @click="type = 'role'">角色</button>
        <button type="button" :class="{ active: type === 'scene' }" :disabled="readonly || busy" @click="type = 'scene'">场景</button>
        <button type="button" :class="{ active: type === 'tool' }" :disabled="readonly || busy" @click="type = 'tool'">道具</button>
      </div>
      <label class="batchUploadDialog__drop" @dragover.prevent @drop.prevent="onDrop">
        <input
          data-field="batch-asset-files"
          type="file"
          multiple
          :accept="type === 'role' ? '.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a,.aac,.ogg' : '.png,.jpg,.jpeg,.webp'"
          :disabled="readonly || busy"
          @change="onPick"
        />
        <strong>选择或拖放多个文件</strong>
        <small>{{ type === "role" ? "角色支持图片和音频；同名 stem 自动关联" : "场景/道具仅支持图片" }}</small>
      </label>
      <ul v-if="inspected.length" class="batchUploadDialog__files">
        <li v-for="item in inspected" :key="item.name" :data-file-status="item.status">
          {{ item.name }} · {{ item.detail }}
        </li>
      </ul>
      <fieldset data-field="batch-asset-ratio">
        <legend>本批图片尺寸</legend>
        <label><input v-model="imageRatio" type="radio" value="16:9" :disabled="readonly || busy" />16:9</label>
        <label><input v-model="imageRatio" type="radio" value="9:16" :disabled="readonly || busy" />9:16</label>
      </fieldset>
      <p class="batchUploadDialog__hint">
        使用文件名 stem 作为资产名；同项目、同类型、同名最后一次上传会覆盖旧扩展。
        新建资产默认图片画幅：{{ imageRatio }}。
      </p>
      <p v-if="error" class="batchUploadDialog__error" role="status">{{ error }}</p>
      <footer>
        <button type="button" :disabled="busy" @click="emit('close')">取消</button>
        <button type="button" data-action="confirm-batch-upload" :disabled="readonly || busy" @click="confirm">{{ busy ? "上传中…" : "开始上传" }}</button>
      </footer>
    </div>
  </t-dialog>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";

const props = defineProps<{ open: boolean; projectUuid: string; readonly?: boolean }>();
const emit = defineEmits<{ close: []; created: [] }>();

const type = ref<"role" | "scene" | "tool">("role");
const imageRatio = ref<"16:9" | "9:16">("16:9");
const files = ref<File[]>([]);
const busy = ref(false);
const error = ref("");

const inspected = computed(() => files.value.map((file) => inspectFile(file, type.value)));

watch(() => props.open, (open) => {
  if (!open) return;
  type.value = "role";
  imageRatio.value = "16:9";
  files.value = [];
  error.value = "";
});

function onVisible(visible: boolean): void {
  if (!visible) emit("close");
}

function inspectFile(file: File, assetType: "role" | "scene" | "tool"): { name: string; status: "ok" | "error"; detail: string } {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) {
    return { name: file.name, status: "ok", detail: `${Math.round(file.size / 1024)} KB · 图片` };
  }
  if (["mp3", "wav", "m4a", "aac", "ogg"].includes(ext)) {
    if (assetType !== "role") {
      return { name: file.name, status: "error", detail: "场景/道具不能上传音频" };
    }
    return { name: file.name, status: "ok", detail: `${Math.round(file.size / 1024)} KB · 音频，将与同名图片关联` };
  }
  return { name: file.name, status: "error", detail: "格式不受支持" };
}

function onPick(event: Event): void {
  files.value = Array.from((event.target as HTMLInputElement).files ?? []);
}

function onDrop(event: DragEvent): void {
  if (props.readonly || busy.value) return;
  files.value = Array.from(event.dataTransfer?.files ?? []);
}

function safeMessage(caught: unknown, fallback: string): string {
  const message = caught && typeof caught === "object" && "message" in caught ? String((caught as { message?: unknown }).message ?? "") : "";
  if (!message || /[A-Za-z]:\\|\\\\|SQLITE|ENOENT|stack/i.test(message)) return fallback;
  return message;
}

async function confirm(): Promise<void> {
  if (props.readonly || busy.value) return;
  const targetProjectUuid = String(props.projectUuid || "").trim();
  if (!targetProjectUuid) {
    error.value = "当前项目不可用";
    return;
  }
  if (!files.value.length) {
    error.value = "请选择要上传的文件";
    return;
  }
  const invalid = inspected.value.filter((item) => item.status === "error");
  if (invalid.length) {
    error.value = "存在非法文件，整批零写入";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    const form = new FormData();
    form.append("type", type.value);
    form.append("imageRatio", imageRatio.value);
    for (const file of files.value) form.append("file", file);
    await axios.post(
      `/tianjiang/runtime/projects/${encodeURIComponent(targetProjectUuid)}/storyboard/assets/batch`,
      form,
    );
    emit("created");
    emit("close");
  } catch (caught) {
    error.value = safeMessage(caught, "批量上传失败");
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped lang="scss">
.batchUploadDialog {
  display: grid;
  gap: 12px;
  color: var(--product-text);
}

.batchUploadDialog__types,
.batchUploadDialog fieldset,
.batchUploadDialog footer {
  display: flex;
  gap: 8px;
}

.batchUploadDialog__types button.active {
  border-color: var(--td-brand-color);
}

.batchUploadDialog__drop {
  display: grid;
  place-items: center;
  min-height: 140px;
  border: 1px dashed var(--product-border);
  border-radius: 12px;
  background: var(--product-surface-soft);
}

.batchUploadDialog__files {
  margin: 0;
  padding-left: 18px;
}

.batchUploadDialog__files [data-file-status="error"] {
  color: var(--td-error-color, #d54941);
}

.batchUploadDialog__error {
  color: var(--td-error-color, #d54941);
  margin: 0;
}

.batchUploadDialog footer {
  justify-content: flex-end;
}
</style>

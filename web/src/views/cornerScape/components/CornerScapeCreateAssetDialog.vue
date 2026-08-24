<template>
  <t-dialog
    :visible="open"
    data-modal="create-asset"
    data-dialog="create-asset"
    :header="title"
    :footer="false"
    attach="body"
    placement="center"
    width="min(720px, calc(100vw - 32px))"
    dialog-class-name="assetActionGlobalDialog"
    @close="emit('close')"
    @update:visible="onVisible"
  >
    <div class="createAssetDialog">
      <label>资产类型
        <select v-model="type" data-field="asset-type" :disabled="readonly || busy">
          <option value="role">角色</option>
          <option value="scene">场景</option>
          <option value="tool">道具</option>
        </select>
      </label>
      <div class="createAssetDialog__row">
        <label>资产名称
          <input v-model="name" data-field="asset-name" type="text" maxlength="80" placeholder="角色名称（必填）" :disabled="readonly || busy" />
        </label>
        <label>别名
          <input v-model="remark" data-field="asset-alias" type="text" maxlength="200" placeholder="逗号、顿号或换行分隔" :disabled="readonly || busy" />
        </label>
      </div>
      <label>详细描述
        <textarea v-model="describe" data-field="asset-describe" rows="3" placeholder="用于后续资产生图的主体描述" :disabled="readonly || busy" />
      </label>
      <label>生图提示词
        <textarea v-model="prompt" data-field="asset-prompt" rows="3" placeholder="生图提示词" :disabled="readonly || busy" />
      </label>
      <fieldset data-field="asset-ratio">
        <legend>图片尺寸 / 画幅</legend>
        <label><input v-model="imageRatio" type="radio" value="16:9" :disabled="readonly || busy" />16:9</label>
        <label><input v-model="imageRatio" type="radio" value="9:16" :disabled="readonly || busy" />9:16</label>
      </fieldset>
      <div class="createAssetDialog__media">
        <label>上传图片
          <input data-field="asset-image" type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" :disabled="readonly || busy" @change="onPickImage" />
          <small>可选，支持 png / jpg / webp</small>
        </label>
        <label v-if="type === 'role'">关联音色
          <input data-field="asset-audio" type="file" accept=".mp3,.wav,.m4a,.aac,.ogg,audio/*" :disabled="readonly || busy" @change="onPickAudio" />
          <small>可选，支持 mp3 / wav / m4a / aac / ogg</small>
        </label>
      </div>
      <p v-if="error" class="createAssetDialog__error" role="status">{{ error }}</p>
      <footer>
        <button type="button" :disabled="busy" @click="emit('close')">取消</button>
        <button type="button" data-action="confirm-create-asset" :disabled="readonly || busy" @click="confirm">{{ busy ? "创建中…" : "创建资产" }}</button>
      </footer>
    </div>
  </t-dialog>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";

const props = defineProps<{ open: boolean; projectUuid: string; readonly?: boolean }>();
const emit = defineEmits<{ close: []; created: [] }>();

const type = ref<"role" | "scene" | "tool">("role");
const name = ref("");
const remark = ref("");
const describe = ref("");
const prompt = ref("");
const imageRatio = ref<"16:9" | "9:16">("16:9");
const image = ref<File | null>(null);
const audio = ref<File | null>(null);
const busy = ref(false);
const error = ref("");

const title = computed(() => (
  type.value === "role" ? "新建角色资产" : type.value === "scene" ? "新建场景资产" : "新建道具资产"
));

watch(() => props.open, (open) => {
  if (!open) return;
  type.value = "role";
  name.value = "";
  remark.value = "";
  describe.value = "";
  prompt.value = "";
  imageRatio.value = "16:9";
  image.value = null;
  audio.value = null;
  error.value = "";
});

function onVisible(visible: boolean): void {
  if (!visible) emit("close");
}

watch(type, (next) => {
  if (next !== "role") audio.value = null;
});

function onPickImage(event: Event): void {
  image.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

function onPickAudio(event: Event): void {
  audio.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

function isAllowedImage(file: File): boolean {
  return /\.(png|jpe?g|webp)$/i.test(file.name);
}

function isAllowedAudio(file: File): boolean {
  return /\.(mp3|wav|m4a|aac|ogg)$/i.test(file.name);
}

function safeMessage(caught: unknown, fallback: string): string {
  const message = caught && typeof caught === "object" && "message" in caught ? String((caught as { message?: unknown }).message ?? "") : "";
  if (!message || /[A-Za-z]:\\|\\\\|SQLITE|ENOENT|stack/i.test(message)) return fallback;
  return message;
}

async function confirm(): Promise<void> {
  if (props.readonly || busy.value) return;
  const targetProjectUuid = String(props.projectUuid || "").trim();
  const trimmed = name.value.trim();
  if (!targetProjectUuid) {
    error.value = "当前项目不可用";
    return;
  }
  if (!trimmed) {
    error.value = "资产名称必填";
    return;
  }
  if (image.value && !isAllowedImage(image.value)) {
    error.value = "图片只支持 png、jpg、jpeg、webp";
    return;
  }
  if (type.value === "role" && audio.value && !isAllowedAudio(audio.value)) {
    error.value = "音色只支持 mp3、wav、m4a、aac、ogg";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    const url = `/tianjiang/runtime/projects/${encodeURIComponent(targetProjectUuid)}/storyboard/assets`;
    if (image.value || (audio.value && type.value === "role")) {
      const form = new FormData();
      form.append("type", type.value);
      form.append("name", trimmed);
      form.append("remark", remark.value.trim());
      form.append("describe", describe.value.trim());
      form.append("prompt", prompt.value.trim());
      form.append("imageRatio", imageRatio.value);
      if (image.value) form.append("image", image.value);
      if (audio.value && type.value === "role") form.append("audio", audio.value);
      await axios.post(url, form);
    } else {
      await axios.post(url, {
        type: type.value,
        name: trimmed,
        remark: remark.value.trim(),
        describe: describe.value.trim(),
        prompt: prompt.value.trim(),
        imageRatio: imageRatio.value,
      });
    }
    emit("created");
    emit("close");
  } catch (caught) {
    error.value = safeMessage(caught, "新建资产失败");
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped lang="scss">
.createAssetDialog {
  display: grid;
  gap: 12px;
  color: var(--product-text);
}

.createAssetDialog__row,
.createAssetDialog__media,
.createAssetDialog fieldset,
.createAssetDialog footer {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.createAssetDialog label,
.createAssetDialog__row label,
.createAssetDialog__media label {
  display: grid;
  gap: 4px;
  flex: 1;
  min-width: 180px;
}

.createAssetDialog input,
.createAssetDialog select,
.createAssetDialog textarea {
  color: inherit;
  background: var(--product-surface-soft);
  border: 1px solid var(--product-border);
  border-radius: 8px;
  padding: 8px 10px;
}

.createAssetDialog__error {
  color: var(--td-error-color, #d54941);
  margin: 0;
}

.createAssetDialog footer {
  justify-content: flex-end;
}
</style>

<template>
  <t-dialog
    :visible="open"
    data-modal="import-asset-descriptions"
    data-dialog="import-asset-descriptions"
    header="导入资产描述"
    :footer="false"
    attach="body"
    placement="center"
    width="min(720px, calc(100vw - 32px))"
    dialog-class-name="assetActionGlobalDialog"
    @close="emit('close')"
    @update:visible="onVisible"
  >
    <div class="importAssetsDialog">
      <label>格式
        <select v-model="format" data-field="import-format" :disabled="readonly || busy">
          <option value="json">JSON</option>
          <option value="csv">CSV</option>
        </select>
      </label>
      <label>清单内容
        <textarea v-model="text" data-field="import-text" rows="8" placeholder="粘贴 JSON 或 CSV" :disabled="readonly || busy" />
      </label>
      <label>从本地选择清单
        <input data-field="import-file" type="file" accept=".json,.csv,text/csv,application/json" :disabled="readonly || busy" @change="onPickFile" />
      </label>
      <div class="importAssetsDialog__samples">
        <button type="button" data-action="download-import-sample-json" @click="downloadSample('json')">下载 JSON 示例</button>
        <button type="button" data-action="download-import-sample-csv" @click="downloadSample('csv')">下载 CSV 示例</button>
      </div>
      <p v-if="summary" data-import-summary>{{ summary }}</p>
      <p v-if="error" class="importAssetsDialog__error" role="status">{{ error }}</p>
      <footer>
        <button type="button" :disabled="busy" @click="emit('close')">取消</button>
        <button type="button" data-action="confirm-import-assets" :disabled="readonly || busy" @click="confirm">{{ busy ? "导入中…" : "导入资产描述" }}</button>
      </footer>
    </div>
  </t-dialog>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";

const props = defineProps<{ open: boolean; projectUuid: string; readonly?: boolean }>();
const emit = defineEmits<{ close: []; created: [] }>();

const format = ref<"json" | "csv">("json");
const text = ref("");
const summary = ref("");
const error = ref("");
const busy = ref(false);

watch(() => props.open, (open) => {
  if (!open) return;
  format.value = "json";
  text.value = "";
  summary.value = "";
  error.value = "";
});

function onVisible(visible: boolean): void {
  if (!visible) emit("close");
}

async function onPickFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 256 * 1024) {
    error.value = "导入文件超过大小上限";
    return;
  }
  text.value = await file.text();
  if (file.name.toLowerCase().endsWith(".csv")) format.value = "csv";
  if (file.name.toLowerCase().endsWith(".json")) format.value = "json";
}

function unwrap(payload: unknown): unknown {
  let value = payload;
  for (let index = 0; index < 3; index += 1) {
    if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, "data")) break;
    value = (value as { data?: unknown }).data;
  }
  return value;
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
  if (!text.value.trim()) {
    error.value = "请粘贴或选择导入清单";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    const response = await axios.post(
      `/tianjiang/runtime/projects/${encodeURIComponent(targetProjectUuid)}/storyboard/assets/import`,
      { format: format.value, text: text.value },
    );
    const result = unwrap(response) as { created?: number; updated?: number; skipped?: number; failed?: number };
    summary.value = `新增 ${Number(result.created ?? 0)}，更新 ${Number(result.updated ?? 0)}，跳过 ${Number(result.skipped ?? 0)}，失败 ${Number(result.failed ?? 0)}`;
    emit("created");
  } catch (caught) {
    error.value = safeMessage(caught, "导入资产描述失败");
  } finally {
    busy.value = false;
  }
}

function downloadSample(kind: "json" | "csv"): void {
  const json = JSON.stringify([
    { type: "role", name: "林夏", aliases: ["夏夏"], description: "女主角", prompt: "portrait", image_ratio: "9:16" },
    { type: "scene", name: "雨夜剧院", description: "主场景", image_params: "rain theatre", image_ratio: "16:9" },
  ], null, 2);
  const csv = "type,name,aliases,description,prompt,image_ratio\nrole,林夏,夏夏,女主角,portrait,9:16\nscene,雨夜剧院,,主场景,rain theatre,16:9\n";
  const blob = new Blob([kind === "json" ? json : csv], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = kind === "json" ? "asset-import-sample.json" : "asset-import-sample.csv";
  link.click();
  URL.revokeObjectURL(url);
}
</script>

<style scoped lang="scss">
.importAssetsDialog {
  display: grid;
  gap: 12px;
  color: var(--product-text);
}

.importAssetsDialog textarea,
.importAssetsDialog select {
  color: inherit;
  background: var(--product-surface-soft);
  border: 1px solid var(--product-border);
  border-radius: 8px;
}

.importAssetsDialog__samples,
.importAssetsDialog footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.importAssetsDialog__error {
  color: var(--td-error-color, #d54941);
  margin: 0;
}
</style>

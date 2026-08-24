<template>
  <div class="storyboardDialogBackdrop" @click.self="emit('close')">
    <section class="storyboardDialog" data-dialog="storyboard-import" data-r10-import="storyboard-import-voice" role="dialog" aria-modal="true" aria-labelledby="storyboard-import-title">
      <header class="storyboardDialog__header"><div><span>SAFE IMPORT</span><h2 id="storyboard-import-title">导入分镜</h2><p>先预览，再安全写入项目</p></div><button type="button" aria-label="关闭导入窗口" @click="emit('close')"><t-icon name="close" /></button></header>
      <div class="storyboardDialog__body">
        <div class="importGuide"><span>1</span><p><strong>选择格式并粘贴内容</strong><small>支持 CSV 与 TXT 的标准字段</small></p><i /><span :class="{ active: digest }">2</span><p><strong>检查预览</strong><small>确认行数与错误后再提交</small></p></div>
        <div class="importToolbar">
          <label class="importFileButton">
            <span>{{ readingFile ? "读取中…" : "导入本地文件" }}</span>
            <input data-action="import-local-file" type="file" accept=".txt,.csv" :disabled="readonly || readingFile" @change="readLocalFile" />
          </label>
          <button type="button" class="dialogSecondary" data-action="download-import-sample" :disabled="readingFile" @click="downloadSample">下载格式示例</button>
        </div>
        <div class="fieldGrid">
          <label class="fieldGroup"><span>导入格式</span><select name="import-format" v-model="format" :disabled="readonly"><option value="csv">CSV 表格</option><option value="txt">TXT 分镜脚本</option></select></label>
          <label class="fieldGroup"><span>写入模式</span><select :value="mode" disabled><option value="append">追加到现有分镜</option></select></label>
        </div>
        <div v-if="format === 'txt'" class="fieldGrid">
          <label class="fieldGroup"><span>TXT 分隔</span>
            <select v-model="delimiterMode" data-field="txt-delimiter-mode" :disabled="readonly">
              <option value="auto">自动识别</option>
              <option value="custom">自定义分隔符</option>
            </select>
          </label>
          <label v-if="delimiterMode === 'custom'" class="fieldGroup"><span>自定义分隔符</span>
            <input data-field="txt-custom-delimiter" v-model="customDelimiter" type="text" :disabled="readonly" placeholder="单独一整行的普通文本" />
          </label>
        </div>
        <div v-if="format === 'txt' && delimiterMode === 'auto'" class="fieldGrid">
          <label class="fieldGroup" v-for="rule in AUTO_RULE_OPTIONS" :key="rule.id">
            <span>{{ rule.label }}</span>
            <input type="checkbox" :data-auto-rule="rule.id" v-model="autoRuleEnabled[rule.id]" :disabled="readonly" />
          </label>
        </div>
        <label class="fieldGroup"><span>原始内容</span><textarea v-model="rawText" rows="9" :disabled="readonly" placeholder="在这里粘贴 CSV 或 TXT 内容。" /></label>
        <div v-if="errorMessage" class="storyboardFeedback is-error" role="alert"><t-icon name="error-circle" />{{ errorMessage }}</div>
        <section v-if="previewCount != null" class="importPreview" data-panel="import-preview"><header><strong>预览结果</strong><span>{{ previewCount }} 条可写入分镜</span></header><p v-if="previewCount === 0">没有识别到有效分镜，请检查字段或分隔符。</p><p v-else>预览摘要已锁定；只有内容和摘要保持一致时才允许提交。</p></section>
      </div>
      <footer class="storyboardDialog__footer"><button type="button" class="dialogSecondary" @click="emit('close')">取消</button><button type="button" class="dialogSecondary" :disabled="readonly || previewing || !rawText.trim()" data-action="preview-import" @click="preview">{{ previewing ? "正在预览…" : "开始预览" }}</button><button type="button" class="dialogPrimary" :disabled="readonly || committing || !digest" data-action="commit-import" @click="commit">{{ committing ? "正在提交…" : "确认提交" }}</button></footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import { reactive, watch } from "vue";
import axios from "@/utils/axios";

const TXT_EXAMPLE = `小节1：
场景：黑屏字卡。
人物：无
镜号1：【黑屏】画面完全漆黑。

小节2：
场景：靠山屯某村民家日。
人物：村民
道具：烂红薯干
镜号1：【室内广角缓推】昏暗土炕上，几个村民瑟缩成一团。
`;

const CSV_EXAMPLE = `场景,人物,道具,分镜提示词
山路悬崖,"沈云禾,陆怀川,工作人员","白布担架,断裂竹篮","承接：无 -> 当前分镜救援队从山里抬出白布担架
场景：山路悬崖
人物：沈云禾、陆怀川、工作人员
▲俯拍，缓慢下压，全景。"
`;

const TXT_SAMPLE_GUIDE = `【自动识别规则（可在导入窗口勾选，不支持手写正则）】
- 小节{序号}：小节1 / 小节 1 / 小节1： / 小节1:
- #{序号}：#1 / # 1
- 分镜{序号}：分镜1 / 分镜 1 / 分镜1： / 分镜1:
- 另兼容「视频段{序号}」，始终启用。
【精确自定义分隔符】
选择“自定义分隔符”后，仅当某一整行等于该文本时才会拆分，不会按正则解释。

`;

const AUTO_RULE_OPTIONS = [
  { id: "section" as const, label: "小节{序号}" },
  { id: "hash" as const, label: "#{序号}" },
  { id: "shot" as const, label: "分镜{序号}" },
];

const props = defineProps<{ projectUuid: string; readonly?: boolean }>();
const emit = defineEmits<{ close: []; committed: [] }>();
const format = ref<"csv" | "txt">("csv");
// 当前后端只实现追加语义；固定模式避免 UI 发出未实现的替换请求。
const mode = "append" as const;
const rawText = ref("");
const digest = ref("");
const previewCount = ref<number | null>(null);
const errorMessage = ref("");
const previewing = ref(false);
const committing = ref(false);
const readingFile = ref(false);
const delimiterMode = ref<"auto" | "custom">("auto");
const customDelimiter = ref("");
const autoRuleEnabled = reactive({
  section: true,
  hash: true,
  shot: true,
});

function runtimeBase(): string {
  return `/tianjiang/storyboard/${encodeURIComponent(props.projectUuid)}`;
}

function contentBase64(): string {
  return btoa(unescape(encodeURIComponent(rawText.value)));
}

function selectedAutoRules(): Array<"section" | "hash" | "shot"> {
  return AUTO_RULE_OPTIONS.map((rule) => rule.id).filter((id) => autoRuleEnabled[id]);
}

function txtDelimiterPayload(): { mode: "auto" | "custom"; delimiter: string; autoRules?: Array<"section" | "hash" | "shot"> } | undefined {
  if (format.value !== "txt") return undefined;
  if (delimiterMode.value === "custom") {
    return { mode: "custom", delimiter: customDelimiter.value };
  }
  const autoRules = selectedAutoRules();
  const allEnabled = AUTO_RULE_OPTIONS.every((rule) => autoRuleEnabled[rule.id]);
  // 中文注释：默认全选时省略 autoRules，与旧请求归一化为同一份配置。
  return allEnabled
    ? { mode: "auto", delimiter: "" }
    : { mode: "auto", delimiter: "", autoRules };
}

const PUBLIC_IMPORT_ERROR_MESSAGES: Record<string, string> = {
  STORYBOARD_IMPORT_TOO_LARGE: "导入文件超过 2MB 限制",
  STORYBOARD_IMPORT_CONTENT_CHANGED: "导入内容已变化，请重新预览",
  STORYBOARD_IMPORT_UNSUPPORTED_FORMAT: "不支持的导入格式",
  STORYBOARD_IMPORT_HAS_ERRORS: "导入内容仍有错误，禁止写入",
  STORYBOARD_EXPORT_UNSUPPORTED_FORMAT: "当前仅支持 CSV/TXT 导出",
  STORYBOARD_IMPORT_FORBIDDEN: "当前身份不能写入该项目",
};

function readSafeServerError(error: unknown, fallback: string): string {
  // 中文注释：只展示白名单稳定 code/message，未知 payload 回退既有通用提示，禁止黑名单放行。
  if (!error || typeof error !== "object") return fallback;
  const record = error as { message?: unknown; code?: unknown };
  const code = typeof record.code === "string" ? record.code.trim() : "";
  if (code && PUBLIC_IMPORT_ERROR_MESSAGES[code]) return PUBLIC_IMPORT_ERROR_MESSAGES[code];
  const message = typeof record.message === "string" ? record.message.trim() : "";
  if (message && Object.values(PUBLIC_IMPORT_ERROR_MESSAGES).includes(message)) return message;
  return fallback;
}

function invalidatePreview(): void {
  digest.value = "";
  previewCount.value = null;
}

watch([format, rawText, delimiterMode, customDelimiter, autoRuleEnabled], () => {
  invalidatePreview();
}, { deep: true });

function readLocalFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || props.readonly) return;
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".csv")) format.value = "csv";
  else if (lower.endsWith(".txt")) format.value = "txt";
  else {
    errorMessage.value = "只支持导入 .txt 或 .csv 文件";
    return;
  }
  readingFile.value = true;
  const reader = new FileReader();
  reader.onload = () => {
    rawText.value = String(reader.result ?? "");
    errorMessage.value = "";
    readingFile.value = false;
  };
  reader.onerror = () => {
    errorMessage.value = "读取分镜文件失败";
    readingFile.value = false;
  };
  reader.readAsText(file, "utf-8");
}

function downloadSample(): void {
  const csv = format.value === "csv";
  const content = csv ? `\uFEFF${CSV_EXAMPLE}` : `${TXT_SAMPLE_GUIDE}${TXT_EXAMPLE}`;
  const blob = new Blob([content], { type: csv ? "text/csv;charset=utf-8" : "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = csv ? "分镜导入示例.csv" : "分镜导入示例.txt";
  anchor.click();
  URL.revokeObjectURL(url);
}

async function preview() {
  // 中文注释：按钮禁用之外再次校验动态权限，阻断脚本触发或权限切换竞态下的请求。
  if (props.readonly || previewing.value || !rawText.value.trim()) return;
  errorMessage.value = "";
  digest.value = "";
  previewing.value = true;
  try {
    const response = await axios.post(`${runtimeBase()}/import/preview`, {
      format: format.value,
      contentBase64: contentBase64(),
      txtDelimiter: txtDelimiterPayload(),
    });
    if (props.readonly) return;
    const payload = response.data?.data ?? response.data;
    digest.value = String(payload?.digest ?? "");
    previewCount.value = Array.isArray(payload?.rows) ? payload.rows.length : 0;
    if (payload?.errors?.length) errorMessage.value = "导入预览失败，请重试";
  } catch (error) {
    errorMessage.value = readSafeServerError(error, "导入预览失败，请重试");
  } finally {
    previewing.value = false;
  }
}

async function commit() {
  // 中文注释：提交前复核只读状态，确保已打开的弹窗也随权限降级立即停止写入。
  if (props.readonly || committing.value || !digest.value) return;
  errorMessage.value = "";
  committing.value = true;
  try {
    await axios.post(`${runtimeBase()}/import/commit`, {
      format: format.value,
      contentBase64: contentBase64(),
      previewDigest: digest.value,
      mode,
      txtDelimiter: txtDelimiterPayload(),
    });
    emit("committed");
  } catch (error) {
    // 中文注释：优先展示服务端稳定安全 message/code，未知错误才回退通用文案。
    errorMessage.value = readSafeServerError(error, "导入提交失败，项目未被修改");
  } finally {
    committing.value = false;
  }
}
</script>

<template>
  <div class="storyboardDialogBackdrop" @click.self="emit('close')">
    <section class="storyboardDialog storyboardDialog--compact" data-dialog="storyboard-export" role="dialog" aria-modal="true" aria-labelledby="storyboard-export-title">
      <header class="storyboardDialog__header"><div><span>PROJECT EXPORT</span><h2 id="storyboard-export-title">导出分镜</h2><p>按当前顺序生成可复用的项目文件</p></div><button type="button" aria-label="关闭导出窗口" @click="emit('close')"><t-icon name="close" /></button></header>
      <div class="storyboardDialog__body"><div class="exportChoices"><button type="button" :class="{ active: format === 'csv' }" @click="format = 'csv'"><t-icon name="file" /><strong>CSV 表格</strong><small>适合表格编辑与回导</small></button><button type="button" :class="{ active: format === 'txt' }" @click="format = 'txt'"><t-icon name="file" /><strong>TXT 文本</strong><small>适合文本归档与检查</small></button></div><p class="exportNotice">导出内容只包含分镜业务数据，不包含模型密钥、登录凭据或本机即梦状态。</p><div v-if="feedback" :class="['storyboardFeedback', failed ? 'is-error' : 'is-success']" role="status">{{ feedback }}</div></div>
      <footer class="storyboardDialog__footer"><button type="button" class="dialogSecondary" @click="emit('close')">取消</button><button type="button" class="dialogPrimary" :disabled="exporting" data-action="confirm-export" @click="download">{{ exporting ? "正在生成…" : "生成并下载" }}</button></footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import { downloadStoryboardExport, type StoryboardExportFormat } from "../storyboard-export-download";

const props = defineProps<{ projectUuid: string }>();
const emit = defineEmits<{ close: [] }>();
const format = ref<StoryboardExportFormat>("csv");
const exporting = ref(false);
const feedback = ref("");
const failed = ref(false);
let dialogActive = true;

onBeforeUnmount(() => {
  dialogActive = false;
});

async function download() {
  if (!props.projectUuid) return;
  const projectAtRequest = props.projectUuid;
  const formatAtRequest = format.value;
  exporting.value = true;
  feedback.value = "";
  failed.value = false;
  try {
    const response = await axios.post(`/tianjiang/storyboard/${encodeURIComponent(projectAtRequest)}/export`, { format: formatAtRequest });
    // 中文注释：项目切换会卸载旧弹窗；A 的晚响应不得在 B 项目上下文触发本机下载。
    if (!dialogActive || props.projectUuid !== projectAtRequest) return;
    // 只消费后端正文；响应头中的路径和文件名一律不参与本机下载。
    downloadStoryboardExport(response, formatAtRequest);
    feedback.value = "分镜已下载";
  } catch {
    if (dialogActive && props.projectUuid === projectAtRequest) {
      failed.value = true;
      feedback.value = "导出失败，请重试";
    }
  } finally {
    if (dialogActive && props.projectUuid === projectAtRequest) exporting.value = false;
  }
}
</script>

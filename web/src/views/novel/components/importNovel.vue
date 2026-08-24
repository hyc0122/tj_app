<template>
  <div class="purgeNovel">
    <t-dialog :footer="false" v-model:visible="purgeNovelShow" :header="$t('workbench.novel.import.title')" width="50%" placement="center">
      <div class="data">
        <t-tabs :value="activeKey" disabled>
          <t-tab-panel value="To1" :label="$t('workbench.novel.import.step1')" style="height: 680px; overflow-y: auto">
            <div class="uploadArea" @click="triggerUpload" @dragover.prevent @drop.prevent="handleDrop">
              <t-upload
                ref="uploadRef"
                v-model="fileList"
                theme="file"
                :multiple="false"
                :max="1"
                :before-upload="handleBeforeUpload"
                :request-method="requestMethod"
                style="display: none" />
              <div class="dragIcon">
                <i-upload-one theme="outline" size="32" fill="var(--td-brand-color)" />
              </div>
              <p class="uploadText">{{ $t("workbench.novel.import.dragUpload") }}</p>
              <p class="uploadHint">{{ $t("workbench.novel.import.uploadHint") }}</p>
            </div>
            <t-divider>{{ $t("workbench.novel.import.or") }}</t-divider>
            <div class="formItem">
              <div class="label">{{ $t("workbench.novel.import.pasteLabel") }}</div>
              <div class="uploadWrap">
                <t-textarea v-model="content" :placeholder="$t('workbench.novel.import.pastePlaceholder')" :autosize="{ minRows: 12, maxRows: 12 }" />
              </div>
              <div class="footerInfo f ac jb" style="margin-top: 8px">
                <div>
                  <span class="charCount">{{ content.length }} {{ $t("workbench.novel.import.chars") }}</span>
                  <span v-if="content.length > 0 && content.length < 100" class="tips warn">{{ $t("workbench.novel.import.tooShort") }}</span>
                </div>
                <span>{{ $t("workbench.novel.import.parsedChapters", { count: tableData.length }) }}</span>
              </div>
            </div>

            <div style="margin-top: 16px; text-align: right">
              <t-button theme="primary" style="margin-left: 10px" :disabled="!content || !tableData.length" @click="activeKey = 'To2'">
                {{ $t("workbench.novel.import.nextStep") }}
              </t-button>
            </div>
          </t-tab-panel>
          <t-tab-panel value="To2" :label="$t('workbench.novel.import.step2')" style="height: 680px; overflow-y: auto">
            <div class="fc to2Box">
              <t-table
                ref="tableRef"
                row-key="index"
                :data="tableData"
                :columns="columns"
                :selected-row-keys="selectedRowKeys"
                hover
                style="flex: 1; overflow-y: auto"
                @select-change="onSelectChange">
                <template #chapterData="{ row }">
                  <t-tooltip :content="row.chapterData" placement="top">
                    <span class="ellipsisText">{{ row.chapterData }}</span>
                  </t-tooltip>
                </template>
              </t-table>
              <div class="selectedInfo">{{ $t("workbench.novel.import.selectedInfo", { count: selectedTextLength }) }}</div>
              <div style="margin-top: 16px; text-align: right">
                <t-button variant="outline" @click="activeKey = 'To1'">{{ $t("workbench.novel.import.prevStep") }}</t-button>
                <t-button theme="primary" style="margin-left: 10px" :loading="nextLoading" @click="keep">
                  保存
                </t-button>
              </div>
            </div>
          </t-tab-panel>
        </t-tabs>
      </div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { LoadingPlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";
import parseNovel from "@/utils/parseNovel";
import mammoth from "mammoth";
import type { UploadFile, PrimaryTableCol, TableRowData } from "tdesign-vue-next";
import projectStore from "@/stores/project";
import {
  allChapterRowKeys,
  normalizeNovelProjectIdInput,
  novelImportErrorMessage,
} from "./novel-import-contract";

const { project } = storeToRefs(projectStore());
interface ChapterItem {
  index: number;
  reel: string;
  chapter: string;
  chapterData: string;
}

const purgeNovelShow = defineModel<boolean>();

const activeKey = ref("To1");
const uploadRef = ref();
const content = ref("");
const fileList = ref<any[]>([]);
const selectedRowKeys = ref<number[]>([]);
/** 上一轮解析章节签名；仅签名变化时重新默认全选。 */
const lastChapterSignature = ref("");

const nextLoading = ref(false);

const columns: PrimaryTableCol<TableRowData>[] = [
  { colKey: "row-select", type: "multiple", width: 60 },
  { colKey: "index", title: $t("workbench.novel.import.col.chapter"), width: 100 },
  { colKey: "reel", title: $t("workbench.novel.import.col.reel"), width: 100 },
  { colKey: "chapter", title: $t("workbench.novel.import.col.chapterName"), width: 200, ellipsis: true },
  { colKey: "chapterData", title: $t("workbench.novel.import.col.chapterData"), ellipsis: true },
];

// 解析后的章节数据
const tableData = computed<ChapterItem[]>(() => {
  if (!content.value) return [];
  try {
    return parseNovel(content.value).flatMap((reel) =>
      reel.chapters.map((chapter) => ({
        index: chapter.index,
        reel: reel.reel,
        chapter: chapter.chapter,
        chapterData: chapter.text,
      })),
    );
  } catch (e) {
    console.error("解析小说内容出错:", e);
    return [];
  }
});

// 选中的行数据
const selectedRows = computed(() => tableData.value.filter((item) => selectedRowKeys.value.includes(item.index)));

// 已选文本总长度
const selectedTextLength = computed(() => selectedRows.value.reduce((sum, item) => sum + item.chapterData.length, 0));

// 触发上传
function triggerUpload() {
  uploadRef.value?.triggerUpload();
}

// 处理拖拽上传
async function handleDrop(e: DragEvent) {
  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    await handleBeforeUpload({ raw: files[0] });
  }
}

// 读取文件内容
async function readFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  if (file.type === "text/plain") {
    return new TextDecoder().decode(buffer);
  }
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return result.value;
}
function requestMethod() {
  return Promise.resolve({
    response: {},
    status: "success",
  } as const);
}

// 上传前校验并解析
async function handleBeforeUpload(file: UploadFile) {
  const rawFile = file.raw;
  if (!rawFile) {
    window.$message.error($t("workbench.novel.import.msg.selectFile"));
    return false;
  }
  const allowTypes = ["text/plain", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];

  if (rawFile.type === "application/msword") {
    window.$message.warning($t("workbench.novel.import.msg.docNotSupported"));
    return false;
  }
  if (!allowTypes.includes(rawFile.type)) {
    window.$message.error($t("workbench.novel.import.msg.unsupportedType"));
    return false;
  }
  if (rawFile.size > 10 * 1024 * 1024) {
    window.$message.error($t("workbench.novel.import.msg.fileTooLarge"));
    return false;
  }

  LoadingPlugin(true);
  try {
    content.value = await readFile(rawFile);
  } catch {
    window.$message.error($t("workbench.novel.import.msg.parseFailed"));
  } finally {
    LoadingPlugin(false);
  }
  return false;
}

// 勾选变化：用户手动取消后不得被无关渲染重新全选。
function onSelectChange(selectedKeys: Array<string | number>, _context: { selectedRowData: TableRowData[] }) {
  selectedRowKeys.value = selectedKeys.map((key) => Number(key)).filter((key) => Number.isSafeInteger(key));
}

/** select 回调必须 await 列表刷新并返回是否真实可见。 */
const emit = defineEmits<{
  select: [];
  imported: [];
}>();

/** 由父组件注入：导入成功后重置筛选、await 列表并确认可见。 */
const props = defineProps<{
  confirmVisible?: () => Promise<boolean>;
}>();

/** 章节集合签名：index 序列变化视为重新解析。 */
function chapterSignature(rows: ReadonlyArray<{ index: number }>): string {
  return rows.map((row) => row.index).join(",");
}

// 文本/DOCX 解析出新章节集时默认全选；同一集合上的手动选择保持不变。
watch(
  tableData,
  (rows) => {
    const signature = chapterSignature(rows);
    if (signature === lastChapterSignature.value) return;
    lastChapterSignature.value = signature;
    selectedRowKeys.value = allChapterRowKeys(rows);
  },
  { immediate: true },
);

// 保存小说：事务提交 + 列表真实可见后才提示成功；失败不关弹窗。
async function keep() {
  nextLoading.value = true;
  if (!selectedRows.value.length) {
    window.$message.warning($t("workbench.novel.import.msg.selectChapters"));
    nextLoading.value = false;
    return;
  }
  try {
    // 运行时 open 可能把本地主键以字符串回传；发送前规范为 JSON number。
    const projectId = normalizeNovelProjectIdInput(project.value?.id as unknown);
    const addRes = await axios.post("/novel/addNovel", {
      projectId,
      data: selectedRows.value,
    });
    const addBody = (addRes as { data?: { count?: unknown; insertedIds?: unknown } })?.data
      ?? (addRes as { count?: unknown; insertedIds?: unknown });
    const count = Number((addBody as { count?: unknown })?.count ?? 0);
    const insertedIds = Array.isArray((addBody as { insertedIds?: unknown })?.insertedIds)
      ? (addBody as { insertedIds: unknown[] }).insertedIds
      : [];
    if (!(count > 0 || insertedIds.length > 0)) {
      throw new Error($t("workbench.novel.import.msg.saveNotConfirmed") as string);
    }

    // 必须 await 父级列表刷新；禁止仅凭 HTTP 200 报成功。
    let visible = false;
    if (typeof props.confirmVisible === "function") {
      visible = await props.confirmVisible();
    } else {
      emit("select");
      visible = true;
    }
    if (!visible) {
      window.$message.warning($t("workbench.novel.import.msg.savedButHidden") as string);
      // 数据已写入但当前筛选不可见：不关弹窗误报，明确提示。
      return;
    }
    window.$message.success($t("workbench.novel.import.msg.saveSuccess"));
    emit("imported");
    purgeNovelShow.value = false;
  } catch (e) {
    // 失败：不关弹窗、不报成功。
    window.$message.error(novelImportErrorMessage(e));
  } finally {
    nextLoading.value = false;
  }
}

// 关闭弹窗时重置内容与选择状态。
watch(purgeNovelShow, (newVal) => {
  if (!newVal) {
    content.value = "";
    fileList.value = [];
    selectedRowKeys.value = [];
    lastChapterSignature.value = "";
    activeKey.value = "To1";
  }
});
</script>

<style lang="scss" scoped>
.purgeNovel {
  .data {
    .uploadArea {
      margin-top: 20px;
      padding: 42px 20px;
      border: 2px dashed #969494;
      border-radius: 8px;
      text-align: center;
      cursor: pointer;
      transition: all 0.2s;
      &:hover {
        border-color: #000000;
      }

      .dragIcon {
        margin-bottom: 12px;
      }

      .uploadText {
        font-size: 14px;
        margin: 0 0 8px;
      }

      .uploadHint {
        font-size: 12px;
        margin: 0;
      }
    }
    .to2Box {
      height: 100%;
    }
    .formItem {
      .label {
        font-weight: 500;
        margin-bottom: 8px;
      }
      .footerInfo {
        font-size: 12px;
        .tips.warn {
          margin-left: 8px;
        }
      }
    }
  }
}
.ellipsisText {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
  max-width: 100%;
}
.selectedInfo {
  margin-top: 12px;
  font-size: 14px;
}
</style>

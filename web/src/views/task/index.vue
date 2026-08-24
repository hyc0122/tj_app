<template>
  <div class="task">
    <div class="header">
      <div class="headerInfo fc">
        <span class="title">{{ $t("workbench.task.title") }}</span>
        <span class="sub">{{ $t("workbench.task.subtitle") }}</span>
      </div>
      <t-button @click="refreshTaskCenter">
        <template #icon>
          <i-redo :size="20" />
        </template>
        {{ $t("workbench.task.refresh") }}
      </t-button>
      <t-button
        variant="outline"
        :loading="queueActionPending"
        :disabled="queueActionPending || queuePauseReason === 'disabled'"
        @click="toggleDreaminaQueue"
      >
        {{ queuePaused ? $t("workbench.task.resumeQueue") : $t("workbench.task.pauseQueue") }}
      </t-button>
      <span class="queuePauseReason" :data-queue-pause-reason="queuePauseReason">{{ queuePauseReasonText }}</span>
    </div>
    <div class="list">
      <div class="search f">
        <t-select :label="$t('workbench.task.project')" v-model="projectUuid" :options="projectData" @change="onFilterChange" />
        <t-select
          :label="$t('workbench.task.categoryLabel')"
          v-model="taskClass"
          :options="categoryOptions"
          @change="onFilterChange"
          style="margin-left: 20px" />
        <t-select
          :label="$t('workbench.task.stateLabel')"
          v-model="taskState"
          :options="stateOptions"
          @change="onFilterChange"
          style="margin-left: 20px" />
      </div>
      <div class="content">
        <t-table :data="taskList" :columns="columns" row-key="rowKey" :loading="pagination.loading" hover stripe>
          <template #reason="{ row }">
            <button
              v-if="row.reason"
              type="button"
              class="reasonText"
              :aria-label="`查看完整失败原因：${row.reason}`"
              @click="openReasonDialog(row.reason)"
            >
              {{ row.reason }}
            </button>
            <span v-else>-</span>
          </template>
          <template #state="{ row }">
            <t-tooltip v-if="row.reason || row.state === '生成失败'" :content="row.reason ? '点击失败原因查看完整内容' : $t('workbench.task.noFailReason')" placement="top">
              <span class="stateText" :class="taskStateClass(row)">{{ row.state }}</span>
            </t-tooltip>
            <span v-else class="stateText" :class="taskStateClass(row)">
              {{ row.state }}
            </span>
          </template>
          <template #startTime="{ row }">
            <span>{{ dayjs(row.startTime).format("YYYY-MM-DD HH:mm:ss") }}</span>
          </template>
        </t-table>
        <t-pagination
          class="paginationWrap"
          v-model:current="pagination.page"
          v-model:pageSize="pagination.limit"
          show-sizer
          :total="pagination.total"
          @page-size-change="getTaskList"
          @current-change="getTaskList" />
      </div>
    </div>
    <div
      v-if="reasonDialogVisible"
      class="reasonDialogBackdrop"
      role="presentation"
      @click.self="closeReasonDialog"
    >
      <section class="reasonDialog" role="dialog" aria-modal="true" aria-label="完整失败原因">
        <div class="reasonDialogHeader">
          <strong>失败原因</strong>
          <button type="button" class="reasonDialogClose" aria-label="关闭失败原因" @click="closeReasonDialog">×</button>
        </div>
        <pre class="reasonDialogContent">{{ selectedReason }}</pre>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import dayjs from "dayjs";
import { MessagePlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";

interface TaskItem {
  id: number;
  taskClass: string;
  relatedObjects: string;
  model: string;
  projectName: string;
  projectUuid?: string;
  rowKey?: string;
  episode: string;
  state: string;
  startTime: number;
  describe?: string;
  reason?: string;
}

const columns = [
  { colKey: "projectName", title: $t("workbench.task.project"), width: 140, ellipsis: true },
  { colKey: "taskClass", title: $t("workbench.task.col.taskClass"), width: 120, ellipsis: true },
  { colKey: "relatedObjects", title: $t("workbench.task.col.relatedObjects"), width: 120, ellipsis: true },
  { colKey: "model", title: $t("workbench.task.col.model"), width: 280, ellipsis: true },
  { colKey: "describe", title: $t("workbench.task.col.describe"), ellipsis: true },
  { colKey: "reason", title: $t("workbench.task.col.reason"), ellipsis: true, cell: "reason" },
  { colKey: "state", title: $t("workbench.task.col.state"), width: 100, cell: "state" },
  { colKey: "startTime", title: $t("workbench.task.col.startTime"), width: 200, cell: "startTime" },
];

const stateOptions = [
  { label: $t("workbench.task.stateAll"), value: "" },
  { label: $t("workbench.task.stateQueued"), value: "排队中" },
  { label: $t("workbench.task.stateGenerating"), value: "生成中" },
  { label: $t("workbench.task.stateRunning"), value: "进行中" },
  { label: $t("workbench.task.stateCompleted"), value: "已完成" },
  { label: $t("workbench.task.stateFailed"), value: "生成失败" },
  { label: $t("workbench.task.stateUnknown"), value: "结果待确认" },
  { label: $t("workbench.task.stateCancelled"), value: "已取消" },
];
type QueuePauseReason = "none" | "disabled" | "manual_pause" | "lifecycle_drain";
interface DreaminaQueueState {
  paused?: boolean;
  pauseReason?: QueuePauseReason;
}

const queuePaused = ref(false);
const queuePauseReason = ref<QueuePauseReason>("none");
const queueActionPending = ref(false);
const queuePauseReasonText = computed(() => {
  if (queuePauseReason.value === "disabled") return "即梦 CLI 已关闭";
  if (queuePauseReason.value === "manual_pause") return "队列已手动暂停";
  if (queuePauseReason.value === "lifecycle_drain") return "队列正在生命周期排空";
  return "队列自动领取中";
});

const pagination = ref({ page: 1, limit: 10, total: 0, loading: false });
const categoryOptions = ref<{ label: string; value: string }[]>([]);
const projectData = ref<{ label: string; value: string }[]>([]);
const taskClass = ref("");
const taskState = ref("");
/** 筛选值使用稳定 projectUuid，不再混用活动项目数字 id */
const projectUuid = ref("");
const taskList = ref<TaskItem[]>([]);
const reasonDialogVisible = ref(false);
const selectedReason = ref("");
/** 列表请求失败只提示一次，避免类别/项目并行失败刷屏 */
let listErrorNotified = false;
const TASK_CENTER_REFRESH_INTERVAL_MS = 5_000;
let taskCenterRefreshTimer: ReturnType<typeof setInterval> | null = null;
let taskCenterRefreshPending = false;

onMounted(() => {
  void refreshTaskCenter();
  void getCategories();
  void getProject();
  taskCenterRefreshTimer = setInterval(() => {
    void refreshTaskCenter();
  }, TASK_CENTER_REFRESH_INTERVAL_MS);
});

onUnmounted(() => {
  if (taskCenterRefreshTimer !== null) clearInterval(taskCenterRefreshTimer);
  taskCenterRefreshTimer = null;
});

async function refreshTaskCenter() {
  if (taskCenterRefreshPending) return;
  taskCenterRefreshPending = true;
  try {
    await Promise.all([getTaskList(), getDreaminaQueueState()]);
  } finally {
    taskCenterRefreshPending = false;
  }
}

function taskStateClass(row: TaskItem): string {
  if (row.state === "生成失败" || row.state === "结果待确认") return "stateFail";
  if (["排队中", "生成中", "进行中", "等待原设备"].includes(row.state)) {
    return "stateRunning";
  }
  return "stateSuccess";
}

function openReasonDialog(reason: string) {
  selectedReason.value = reason;
  reasonDialogVisible.value = true;
}

function closeReasonDialog() {
  reasonDialogVisible.value = false;
}

function onFilterChange() {
  pagination.value.page = 1;
  void getTaskList();
}

async function toggleDreaminaQueue() {
  if (queueActionPending.value || queuePauseReason.value === "disabled") return;
  const path = queuePaused.value ? "/task/dreaminaQueue/resume" : "/task/dreaminaQueue/pause";
  queueActionPending.value = true;
  try {
    const response = await axios.post(path);
    // 中文注释：队列控制必须采用服务端成功响应，失败时禁止乐观翻转按钮状态。
    applyDreaminaQueueState(response.data);
  } catch (error) {
    MessagePlugin.error((error as Error)?.message || "即梦队列状态更新失败");
  } finally {
    queueActionPending.value = false;
  }
}

function applyDreaminaQueueState(payload: unknown) {
  const record = payload && typeof payload === "object" ? payload as { data?: DreaminaQueueState } & DreaminaQueueState : {};
  const queue = record.data ?? record;
  const reason = queue.pauseReason ?? (queue.paused ? "manual_pause" : "none");
  queuePauseReason.value = reason;
  queuePaused.value = reason !== "none";
}

async function getDreaminaQueueState() {
  try {
    const response = await axios.get("/task/dreaminaQueue/getState");
    applyDreaminaQueueState(response.data);
  } catch {
    // 中文注释：状态读取失败时保持现有显示，避免把未知状态误报为可领取。
  }
}

async function getCategories() {
  try {
    const { data } = await axios.post("/task/getTaskCategories");
    const rows = Array.isArray(data) ? data : [];
    categoryOptions.value = [
      { label: $t("workbench.task.stateAll"), value: "" },
      ...rows
        .filter((item: { taskClass?: string }) => item?.taskClass)
        .map((item: { taskClass: string }) => ({
          label: item.taskClass,
          value: item.taskClass,
        })),
    ];
  } catch {
    categoryOptions.value = [{ label: $t("workbench.task.stateAll"), value: "" }];
  }
}

async function getProject() {
  try {
    const { data } = await axios.post("/task/getProject");
    const rows = Array.isArray(data) ? data : [];
    projectData.value = [
      { label: $t("workbench.task.stateAll"), value: "" },
      ...rows.map((item: { name?: string; projectUuid?: string; id?: number }) => ({
        label: String(item.name ?? item.projectUuid ?? ""),
        value: String(item.projectUuid ?? ""),
      })).filter((item: { value: string }) => item.value),
    ];
  } catch {
    projectData.value = [{ label: $t("workbench.task.stateAll"), value: "" }];
  }
}

async function getTaskList() {
  pagination.value.loading = true;
  listErrorNotified = false;
  try {
    const { data } = await axios.post("/task/getTaskApi", {
      page: pagination.value.page,
      limit: pagination.value.limit,
      taskClass: taskClass.value || null,
      state: taskState.value || null,
      projectUuid: projectUuid.value || null,
    });
    const payload = data && typeof data === "object" ? data : { data: [], total: 0 };
    taskList.value = (Array.isArray(payload.data) ? payload.data : []).map(
      (row: TaskItem) => ({
        ...row,
        rowKey: row.rowKey || `${row.projectUuid ?? "unknown"}:${row.id}`,
      }),
    );
    pagination.value.total = Number(payload.total ?? 0) || 0;
  } catch {
    taskList.value = [];
    pagination.value.total = 0;
    if (!listErrorNotified) {
      listErrorNotified = true;
      window.$message.error($t("workbench.task.fetchFailed"));
    }
  } finally {
    pagination.value.loading = false;
  }
}
</script>

<style lang="scss" scoped>
.task {
  .header {
    padding-top: 32px;
    margin-bottom: 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    .title {
      font-size: 32px;
      font-weight: 600;
    }
    .sub {
      opacity: 0.5;
    }
    .queuePauseReason {
      color: var(--td-text-color-secondary);
      font-size: 13px;
      white-space: nowrap;
    }
  }
  .stateText {
    font-weight: bold;
  }
  .stateFail {
    color: #ff4d4f;
    cursor: pointer;
  }
  .stateRunning {
    color: #1890ff;
  }
  .stateSuccess {
    color: #52c41a;
  }
  .reasonText {
    display: block;
    width: 100%;
    padding: 0;
    overflow: hidden;
    color: inherit;
    font: inherit;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
    background: transparent;
    border: 0;
  }
  .reasonDialogBackdrop {
    position: fixed;
    z-index: 3000;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
    background: rgb(0 0 0 / 55%);
  }
  .reasonDialog {
    width: min(920px, 92vw);
    max-height: 82vh;
    padding: 20px;
    color: var(--td-text-color-primary);
    background: var(--td-bg-color-container);
    border: 1px solid var(--td-component-border);
    border-radius: 10px;
    box-shadow: var(--td-shadow-3);
  }
  .reasonDialogHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
    font-size: 18px;
  }
  .reasonDialogClose {
    padding: 4px 10px;
    color: inherit;
    font-size: 24px;
    line-height: 1;
    cursor: pointer;
    background: transparent;
    border: 0;
  }
  .reasonDialogContent {
    max-height: calc(82vh - 86px);
    margin: 0;
    overflow: auto;
    font: inherit;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .paginationWrap {
    margin-top: 10px;
  }
}
</style>

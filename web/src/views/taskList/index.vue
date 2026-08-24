<template>
  <div class="taskList">
    <div class="header">
      <h2 class="title">我的任务</h2>
    </div>
    <div class="search f">
      <div>
        <t-select label="任务大类：" v-model="taskClass" :options="taskCategories" />
      </div>
      <div style="margin-left: 20px">
        <t-select label="状态：" v-model="state">
          <t-option key="1" label="进行中" value="1" />
          <t-option key="2" label="已完成" value="2" />
        </t-select>
      </div>
      <t-button style="margin-left: 10px" :loading="pageValue.loading" @click="onSearch">查询</t-button>
      <t-button style="margin-left: 8px" variant="outline" @click="onReset">重置</t-button>
    </div>
    <div class="content">
      <vxe-table ref="tableRef" :data="taskItem">
        <vxe-column title="任务大类" field="taskClass" width="200" show-overflow="title"></vxe-column>
        <vxe-column title="关联对象" field="relatedObjects" width="200" show-overflow="title"></vxe-column>
        <vxe-column title="模型" field="model" width="200" show-overflow="title"></vxe-column>
        <vxe-column title="描述" field="describe" show-header-overflow show-overflow="title" show-footer-overflow></vxe-column>
        <vxe-column title="状态" field="state" width="150">
          <template #default="{ row }">
            <span
              :style="{
                color: row.state === '进行中' ? '#1890ff' : '#52c41a',
                fontWeight: 'bold',
              }">
              {{ row.state }}
            </span>
          </template>
        </vxe-column>
        <vxe-column title="时间" field="startTime" width="150">
          <template #default="{ row }">
            {{ dayjs(row.startTime).format("YYYY-MM-DD HH:mm:ss") }}
          </template>
        </vxe-column>
      </vxe-table>
      <div class="pagination" style="margin-top: 10px; text-align: right">
        <t-pagination
          v-model:current="pageValue.page"
          v-model:pageSize="pageValue.limit"
          show-size-changer
          :total="pageValue.total"
          @page-size-change="onPageSizeChange"
          @current-change="onPageChange" />
      </div>
      <taskDetails v-model:open="open" :row="currentRow"></taskDetails>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import store from "@/stores";
import axios from "@/utils/axios";
import dayjs from "dayjs";
import taskDetails from "./components/taskDetails.vue";

const { projectId } = storeToRefs(store());
interface taskData {
  id: number;
  taskClass: string;
  relatedObjects: string;
  model: string;
  projectName: string;
  episode: string;
  state: string;
  startTime: number;
}
const pageValue = ref({
  page: 1,
  limit: 10,
  total: 0,
  loading: false,
});
const taskCategories = ref<{ label: string; value: string }[]>([]);
const taskClass = ref<string>("");
const state = ref<string>("");
const taskItem = ref<taskData[]>([]);
const open = ref<boolean>(false);
const currentRow = ref<any>(null);
/** 请求代际：防止并发重复提示。 */
let listRequestSeq = 0;

function onSearch() {
  pageValue.value.page = 1;
  void getTaskList();
}

function onReset() {
  taskClass.value = "";
  state.value = "";
  pageValue.value.page = 1;
  void getTaskList();
}

function onPageSizeChange(pageSize: number) {
  pageValue.value.limit = pageSize;
  pageValue.value.page = 1;
  void getTaskList();
}

function onPageChange(page: number) {
  pageValue.value.page = page;
  void getTaskList();
}

onMounted(() => {
  getTaskCategories();
  void getTaskList();
});

function getTaskCategories() {
  axios
    .post("/task/getTaskCategories", {
      projectId: projectId.value,
    })
    .then(({ data }) => {
      taskCategories.value = data.map((item: any) => ({
        label: item.taskClass,
        value: item.taskClass,
      }));
      taskCategories.value.unshift({ label: "全部", value: "" });
    })
    .catch(() => {
      window.$message.error("获取任务大类失败");
    });
}

async function getTaskList() {
  const seq = ++listRequestSeq;
  pageValue.value.loading = true;
  try {
    // 必须使用已注册的任务列表 API。
    const { data } = await axios.post("/task/getTaskApi", {
      page: pageValue.value.page,
      limit: pageValue.value.limit,
      taskClass: taskClass.value,
      state: state.value,
      projectId: projectId.value,
    });
    if (seq !== listRequestSeq) return;
    taskItem.value = Array.isArray(data?.data) ? data.data : [];
    pageValue.value.total = Number(data?.total ?? 0) || 0;
  } catch {
    if (seq !== listRequestSeq) return;
    // 空列表不走 catch；仅真实失败提示一次。
    window.$message.error("获取任务列表失败");
  } finally {
    if (seq === listRequestSeq) pageValue.value.loading = false;
  }
}
</script>

<style lang="scss" scoped>
.taskList {
  width: 100%;
  margin: 0 auto;
  padding: 32px;
  background: transparent;
  .search {
    margin-bottom: 2rem;
    display: flex;
    align-items: center;
    .ant-input-group {
      margin-right: 1rem;
    }
  }
  .header {
    margin-bottom: 2rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    .title {
      font-size: 2rem;
      font-weight: 600;
      color: #1a202c;
      margin-bottom: 0.5rem;
    }
  }
}
</style>

<template>
  <section class="assetWorkspace" data-panel="asset-manager">
    <header class="moduleHero">
      <div><span>ASSET LIBRARY</span><h2>资产管理</h2><p>{{ sourceProjectUuid ? `来源项目：${sourceProjectUuid}` : "独立资产库，仅服务当前分镜项目" }}</p></div>
      <div class="moduleHero__actions">
        <t-button v-if="!readonly" theme="primary" data-action="create-asset" @click="openCreate">
          <template #icon><t-icon name="add" /></template>新建资产
        </t-button>
        <t-button variant="outline" :loading="loading" data-action="refresh-assets" @click="reload">
          <template #icon><t-icon name="refresh" /></template>刷新资产
        </t-button>
      </div>
    </header>

    <div class="moduleMetrics">
      <article><span>资产总数</span><strong>{{ assets.length }}</strong><small>已进入当前可用范围</small></article>
      <article><span>角色</span><strong>{{ typeCount("role") }}</strong><small>人物与形象设定</small></article>
      <article><span>场景</span><strong>{{ typeCount("scene") }}</strong><small>环境与空间设定</small></article>
      <article><span>权限</span><strong>{{ permissionLabel }}</strong><small>{{ readonly ? "不可修改绑定" : "允许编辑与绑定" }}</small></article>
    </div>

    <div class="assetToolbar">
      <label class="storyboardSearch"><t-icon name="search" /><input v-model="searchText" type="search" placeholder="搜索资产名称" /></label>
      <div class="assetFilters" role="group" aria-label="资产类型筛选">
        <button v-for="filter in filters" :key="filter.value" type="button" :class="{ active: activeType === filter.value }" @click="activeType = filter.value">{{ filter.label }}</button>
      </div>
    </div>
    <p class="assetBindingHint">请在镜头详情中绑定资产。新建后可立即在分镜角色、场景、道具槽位中选择。</p>

    <div v-if="errorMessage" class="storyboardFeedback is-error" role="status"><t-icon name="error-circle" />{{ errorMessage }}</div>
    <div v-if="loading && assets.length === 0" class="assetGrid assetGrid--loading"><i v-for="index in 6" :key="index" /></div>
    <div v-else-if="filteredAssets.length === 0" class="moduleEmpty"><span><t-icon name="image" /></span><strong>暂无匹配资产</strong><p>调整筛选条件，或先新建角色、场景和道具。</p></div>
    <div v-else class="assetGrid">
      <article v-for="asset in filteredAssets" :key="asset.assetUuid" class="assetCard module-interactive" :data-asset-id="asset.assetUuid">
        <div class="assetCard__visual"><img v-if="safeStoryboardAssetMediaUrl(asset.coverUrl)" :src="safeStoryboardAssetMediaUrl(asset.coverUrl)" :alt="asset.name" /><span v-else>{{ asset.name.slice(0, 1) }}</span><i>{{ typeLabel(asset.assetType) }}</i></div>
        <div class="assetCard__body"><strong>{{ asset.name }}</strong><p>{{ asset.description || "暂无补充描述" }}</p><small>{{ asset.assetUuid }}</small></div>
      </article>
    </div>

    <div v-if="createOpen" class="assetCreateModal" data-dialog="create-asset">
      <section class="assetCreatePanel">
        <header><strong>新建资产</strong><button type="button" @click="createOpen = false">关闭</button></header>
        <label>类型
          <select v-model="draftType" data-field="asset-type">
            <option value="role">角色</option>
            <option value="scene">场景</option>
            <option value="tool">道具</option>
          </select>
        </label>
        <label>名称
          <input v-model="draftName" data-field="asset-name" type="text" maxlength="80" placeholder="资产名称" />
        </label>
        <label>描述
          <textarea v-model="draftDescribe" data-field="asset-describe" rows="3" placeholder="可选描述" />
        </label>
        <label>图片
          <input data-field="asset-image" type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" @change="onPickImage" />
        </label>
        <p v-if="createError" class="storyboardFeedback is-error">{{ createError }}</p>
        <footer>
          <button type="button" @click="createOpen = false">取消</button>
          <button type="button" data-action="confirm-create-asset" :disabled="creating" @click="confirmCreate">{{ creating ? "创建中…" : "创建资产" }}</button>
        </footer>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import { normalizeStoryboardAssetEnvelope } from "../storyboard-asset-normalizer";
import { safeStoryboardAssetMediaUrl } from "../storyboard-media-url";
import type { WorkspaceAsset } from "../storyboard-workbench-types";

const props = defineProps<{ projectUuid?: string; sourceProjectUuid?: string; readonly?: boolean }>();
const emit = defineEmits<{ created: [asset: WorkspaceAsset] }>();
const assets = ref<WorkspaceAsset[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const searchText = ref("");
const activeType = ref("all");
const createOpen = ref(false);
const creating = ref(false);
const createError = ref("");
const draftType = ref<"role" | "scene" | "tool">("role");
const draftName = ref("");
const draftDescribe = ref("");
const draftFile = ref<File | null>(null);
const filters = [
  { value: "all", label: "全部" }, { value: "role", label: "角色" },
  { value: "scene", label: "场景" }, { value: "tool", label: "道具" },
];
const permissionLabel = computed(() => (props.readonly ? "只读" : "可编辑"));
const filteredAssets = computed(() => {
  const keyword = searchText.value.trim().toLowerCase();
  return assets.value.filter((asset) => (activeType.value === "all" || asset.assetType === activeType.value)
    && (!keyword || asset.name.toLowerCase().includes(keyword) || String(asset.description ?? "").toLowerCase().includes(keyword)));
});

function unwrap(payload: unknown): unknown {
  let value = payload;
  for (let index = 0; index < 3; index += 1) {
    if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, "data")) break;
    value = (value as { data?: unknown }).data;
  }
  return value;
}

function typeCount(type: string): number { return assets.value.filter((asset) => asset.assetType === type).length; }
function typeLabel(type: string): string { return ({ role: "角色", scene: "场景", tool: "道具", clip: "素材", audio: "音频" } as Record<string, string>)[type] || "资产"; }

async function reload() {
  if (!props.projectUuid) return;
  loading.value = true;
  errorMessage.value = "";
  try {
    const response = await axios.get(`/tianjiang/runtime/projects/${encodeURIComponent(props.projectUuid)}/storyboard/assets`);
    const normalized = normalizeStoryboardAssetEnvelope(
      unwrap(response),
      String(props.sourceProjectUuid || props.projectUuid),
    );
    assets.value = normalized.assets;
  } catch {
    errorMessage.value = "资产读取失败，请重试";
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  if (props.readonly) return;
  draftType.value = "role";
  draftName.value = "";
  draftDescribe.value = "";
  draftFile.value = null;
  createError.value = "";
  createOpen.value = true;
}

function onPickImage(event: Event): void {
  draftFile.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

async function confirmCreate(): Promise<void> {
  if (!props.projectUuid || creating.value) return;
  const name = draftName.value.trim();
  if (!name) {
    createError.value = "请输入资产名称";
    return;
  }
  creating.value = true;
  createError.value = "";
  let created: WorkspaceAsset | null = null;
  try {
    const response = await axios.post(`/tianjiang/runtime/projects/${encodeURIComponent(props.projectUuid)}/storyboard/assets`, {
      type: draftType.value,
      name,
      describe: draftDescribe.value.trim(),
    });
    const payload = unwrap(response) as Record<string, unknown>;
    created = {
      assetUuid: String(payload.assetUuid ?? ""),
      name: String(payload.name ?? name),
      assetType: (payload.type as WorkspaceAsset["assetType"]) || draftType.value,
      description: String(payload.describe ?? ""),
      sourceProjectUuid: String(payload.sourceProjectUuid ?? props.sourceProjectUuid ?? props.projectUuid),
      coverUrl: typeof payload.coverUrl === "string" ? payload.coverUrl : undefined,
    };
    if (draftFile.value && created.assetUuid) {
      const form = new FormData();
      form.append("file", draftFile.value);
      try {
        await axios.post(
          `/tianjiang/runtime/projects/${encodeURIComponent(props.projectUuid)}/storyboard/assets/${encodeURIComponent(created.assetUuid)}/image`,
          form,
        );
      } catch {
        createError.value = "资产已创建，但图片上传失败，可重试";
        await reload();
        emit("created", created);
        return;
      }
    }
    createOpen.value = false;
    await reload();
    emit("created", created);
  } catch {
    createError.value = created ? "资产已创建，但图片上传失败，可重试" : "新建资产失败";
    if (created) await reload();
  } finally {
    creating.value = false;
  }
}

onMounted(() => { void reload(); });
</script>

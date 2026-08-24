import { ref, type Ref } from "vue";
import { storeToRefs } from "pinia";
import type { TabValue } from "tdesign-vue-next";
import axios from "@/utils/axios";
import { localProjectBody, toLocalProjectId } from "@/features/tianjiang/project/local-project-id";
import projectStore from "@/stores/project";
import {
  findAssetById as findAsset,
  getMediaType,
  normalizeSelection,
  type AssetRecord,
  type MediaType,
} from "./assetsLogic";

export type AssetTab = "role" | "tool" | "scene" | "clip" | "audio";

export interface AssetsPageProps {
  selectorMode?: boolean;
  allowedTypes?: AssetTab[];
  clipMediaTypes?: Array<Exclude<MediaType, "unknown">>;
  multiple?: boolean;
}

export interface AssetsProject {
  id: string;
}

export function useAssetsState(props: AssetsPageProps) {
  const { project: projectStoreRef } = storeToRefs(projectStore());
  const project = projectStoreRef as Ref<AssetsProject | null>;
  const allThemeData = [
    { name: $t("workbench.assets.role"), value: "role", icon: "i-permissions" },
    { name: $t("workbench.assets.prop"), value: "tool", icon: "i-tool" },
    { name: $t("workbench.assets.scene"), value: "scene", icon: "i-landscape" },
    { name: $t("workbench.assets.clip"), value: "clip", icon: "i-editing" },
    { name: $t("workbench.assets.audio"), value: "audio", icon: "i-audio-file" },
  ] as const;
  const themeData = ref(
    props.allowedTypes?.length
      ? allThemeData.filter((item) => props.allowedTypes!.includes(item.value))
      : [...allThemeData],
  );
  const initialTab = themeData.value[0]?.value ?? "role";
  const assetOptions = ref<AssetTab>(initialTab);
  const searchText = ref("");
  const selectedRowKeys = ref<Array<string | number>>([]);
  const selectedSubRowKeys = ref<Array<string | number>>([]);
  const expandedRowKeys = ref<Array<string | number>>([]);
  const loading = ref(false);
  const tableData = ref<AssetRecord[]>([]);
  const pagination = ref({ page: 1, pageSize: 10, total: 0, showJumper: true });
  const tabNameMap: Record<AssetTab, string> = {
    role: $t("workbench.assets.role"),
    tool: $t("workbench.assets.prop"),
    scene: $t("workbench.assets.scene"),
    clip: $t("workbench.assets.clip"),
    audio: $t("workbench.assets.audio"),
  };

  const mediaPreviewShow = ref(false);
  const mediaPreviewSrc = ref("");
  const mediaPreviewType = ref<MediaType>("unknown");
  const mediaPreviewName = ref("");

  function findAssetById(id: number) {
    return findAsset(tableData.value, id);
  }

  function isGenerating(id: number) {
    const item = findAssetById(id);
    return item?.promptState === "生成中" || item?.state === "生成中";
  }

  async function getFilteredData(type: string) {
    try {
      loading.value = true;
      const { data } = await axios.post("/assets/getAssetsApi", {
        projectId: toLocalProjectId(project.value?.id),
        type,
        name: searchText.value || undefined,
        page: pagination.value.page,
        limit: pagination.value.pageSize,
      });
      tableData.value = data.data || [];
      if (type === "clip" && props.clipMediaTypes?.length) {
        tableData.value = tableData.value.filter((item) =>
          props.clipMediaTypes!.includes(getMediaType(item.src) as Exclude<MediaType, "unknown">),
        );
      }
      pagination.value.total = data.total || 0;
      return tableData.value;
    } catch (error) {
      console.error("加载资产数据失败:", error);
      tableData.value = [];
      pagination.value.total = 0;
    } finally {
      loading.value = false;
    }
  }

  async function loadCurrentTabData() {
    await getFilteredData(assetOptions.value);
  }

  function handleSearch() {
    pagination.value.page = 1;
    void getFilteredData(assetOptions.value);
  }

  function selectAssetOptions(_value: TabValue) {
    searchText.value = "";
    selectedRowKeys.value = [];
    selectedSubRowKeys.value = [];
    expandedRowKeys.value = [];
    pagination.value.page = 1;
    void loadCurrentTabData();
  }

  function handleSelectChange(value: Array<string | number>) {
    selectedRowKeys.value = normalizeSelection(value, props.multiple !== false, isGenerating);
  }

  function handleSubSelectChange(value: Array<string | number>) {
    selectedSubRowKeys.value = normalizeSelection(value, props.multiple !== false);
  }

  function handleExpandChange(value: Array<string | number>) {
    expandedRowKeys.value = value.length > 3 ? value.slice(-3) : value;
  }

  function handlePageChange(pageInfo: { current: number; pageSize: number }) {
    pagination.value.page = pageInfo.current;
    pagination.value.pageSize = pageInfo.pageSize;
    void loadCurrentTabData();
  }

  function openMediaPreview(src: string, name: string) {
    if (!src) return;
    mediaPreviewSrc.value = src;
    mediaPreviewType.value = getMediaType(src);
    mediaPreviewName.value = name;
    mediaPreviewShow.value = true;
  }

  function closeMediaPreview() {
    mediaPreviewShow.value = false;
    mediaPreviewSrc.value = "";
  }

  async function getBigImageUrl(row: AssetRecord, open: () => void) {
    row.src = row.src?.split("?")[0] ?? "";
    await Promise.resolve();
    open();
  }

  return {
    props,
    project,
    themeData,
    assetOptions,
    searchText,
    selectedRowKeys,
    selectedSubRowKeys,
    expandedRowKeys,
    loading,
    tableData,
    pagination,
    tabNameMap,
    mediaPreviewShow,
    mediaPreviewSrc,
    mediaPreviewType,
    mediaPreviewName,
    findAssetById,
    isGenerating,
    getFilteredData,
    loadCurrentTabData,
    handleSearch,
    selectAssetOptions,
    handleSelectChange,
    handleSubSelectChange,
    handleExpandChange,
    handlePageChange,
    openMediaPreview,
    closeMediaPreview,
    getBigImageUrl,
    getMediaType,
  };
}

export type AssetsState = ReturnType<typeof useAssetsState>;

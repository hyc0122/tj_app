<template>
  <t-select
    :size="props.size"
    v-model="selectValue"
    :name="props.name"
    :disabled="props.disabled"
    :placeholder="props.placeholder ?? t('components.modelSelect.placeholder')"
    :loading="loading && optionsData.length === 0"
    @change="onChange"
    @popup-visible-change="onPopupVisibleChange">
    <t-option-group v-for="(list, index) in optionsData" :key="index" :label="list.group">
      <t-option
        v-for="item in list.children"
        :key="item.id + item.value"
        :value="catalogOptionValue(item)"
        :label="item.label"
        :disabled="item.disabled">
        <div class="optionItem">
          <div class="optionMain">
            <t-avatar
              v-if="getProviderLogoByModel(item.label, item.value)"
              size="24px"
              shape="round"
              :image="getProviderLogoByModel(item.label, item.value)!" />
            <t-avatar v-else size="24px" shape="round" class="fallbackAvatar">{{ getFallbackText(item.label) }}</t-avatar>
            <div class="optionLabel">{{ item.label }}</div>
          </div>
          <span class="optionType">{{ item.disabled ? item.disabledReason || t("components.modelSelect.unavailable") : item.type }}</span>
        </div>
      </t-option>
    </t-option-group>
    <template v-if="optionsData.length === 0" #empty>
      <div class="emptyActionWrap">
        <t-button class="emptyActionButton" size="small" variant="text" theme="primary" @click.stop="goVendorConfig">
          {{ emptyText }}
        </t-button>
      </div>
    </template>
  </t-select>
</template>

<script setup lang="ts">
import { providersLogo, modelProviderRules } from "@/utils/providersLogo";
import settingStore from "@/stores/setting";
import { currentAccountScopeId, modelCatalogStore, type ModelCatalogResponse } from "@/features/models/modelCatalogStore";
import { useI18n } from "vue-i18n";

interface VendorChild {
  id: string;
  label: string;
  value: string;
  vendorId: string;
  type: string;
  disabled?: boolean;
  disabledReason?: string;
}

interface VendorOption {
  group: string;
  id: string;
  children: VendorChild[];
}

const selectValue = defineModel({
  type: String,
  default: "",
});

const selectValueLabel = defineModel("label");
const { t } = useI18n();

const props = defineProps({
  type: {
    type: String as () => "text" | "image" | "all" | "video",
    default: "all",
  },
  size: {
    type: String as () => "small" | "medium" | "large",
    default: "medium",
  },
  placeholder: {
    type: String,
  },
  changeConfig: {
    type: Boolean,
    default: false,
  },
  accountScopeId: {
    type: String,
    default: "",
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  name: {
    type: String,
    default: "",
  },
});

function catalogOptionValue(item: { id: string; value: string }): string {
  const id = String(item.id ?? "");
  const value = String(item.value ?? "");
  // 中文注释：原生即梦目录的 value 已是 providerId:modelName，禁止再拼一层。
  return id && value.startsWith(`${id}:`) ? value : `${id}:${value}`;
}
const emit = defineEmits<{
  change: [value: string, data?: any];
}>();

const optionsData = ref<VendorOption[]>([]);
const loading = ref(false);
const catalogState = ref<"ready" | "checking" | "stale" | "failed">("checking");
const lastVersion = ref(0);

const emptyText = computed(() => {
  if (catalogState.value === "failed" || catalogState.value === "stale") {
    return t("components.modelSelect.msg.fetchModelFailed");
  }
  if (loading.value) return t("components.modelSelect.checking");
  return t("components.modelSelect.goSetting");
});

async function onChange(value: any, { option }: any) {
  if (option?.disabled) return;
  selectValue.value = value;
  selectValueLabel.value = option.label;
  if (props.changeConfig) {
    const { default: axios } = await import("@/utils/axios");
    const { data } = await axios.post("/modelSelect/getModelDetail", {
      modelId: value,
    });
    emit("change", value, data);
  } else {
    emit("change", value);
  }
}

onMounted(() => {
  void loadCatalog();
});

function onPopupVisibleChange(visible: boolean) {
  if (visible) void loadCatalog();
}

function applyCatalog(payload: ModelCatalogResponse, allowClear: boolean) {
  const titleMap: Record<string, string> = {
    image: t("components.modelSelect.type.image"),
    text: t("components.modelSelect.type.text"),
    video: t("components.modelSelect.type.video"),
  };
  const groupMap = new Map<string, VendorOption>();
  for (const item of payload.items ?? []) {
    const groupKey = String(item.id);
    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        group: item.name,
        id: groupKey,
        children: [],
      });
    }
    groupMap.get(groupKey)!.children.push({
      id: groupKey,
      label: item.label,
      value: item.value,
      vendorId: groupKey,
      type: titleMap[item.type] ?? item.type,
      disabled: item.disabled === true,
      disabledReason: item.disabledReason,
    });
  }
  optionsData.value = Array.from(groupMap.values());
  const selected = selectValue.value;
  const exists = optionsData.value.flatMap((group) => group.children).some((item) => catalogOptionValue(item) === selected);
  const confirmedMissing = allowClear
    && payload.catalogVersion > lastVersion.value
    && payload.providers.every((item) => item.state === "ready" || item.state === "disabled")
    && selected
    && !exists;
  if (confirmedMissing) selectValue.value = "";
  lastVersion.value = payload.catalogVersion ?? lastVersion.value;
}

async function loadCatalog() {
  const scope = props.accountScopeId || currentAccountScopeId();
  const cached = modelCatalogStore.peek(scope, props.type);
  if (cached) {
    applyCatalog(cached, false);
    catalogState.value = "ready";
  } else {
    loading.value = true;
    catalogState.value = "checking";
  }
  try {
    const next = await modelCatalogStore.ensure(scope, props.type);
    applyCatalog(next, true);
    catalogState.value = modelCatalogStore.failure(scope, props.type) ? "stale" : "ready";
  } catch {
    catalogState.value = cached ? "stale" : "failed";
  } finally {
    loading.value = false;
  }
}

function getProviderLogoByModel(label?: string, value?: string) {
  const source = `${label || ""} ${value || ""}`.trim();
  if (!source) return null;
  const matchedRule = modelProviderRules.find((rule) => rule.pattern.test(source));
  return matchedRule ? providersLogo[matchedRule.provider] : null;
}

function getFallbackText(label: string) {
  return label?.slice(0, 1)?.toUpperCase() || "M";
}

function goVendorConfig() {
  const store = settingStore();
  store.activeMenu = "vendorConfig";
  store.showSetting = true;
}
</script>

<style lang="scss" scoped>
.optionItem {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.optionMain {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.optionLabel {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.optionType {
  color: var(--td-text-color-secondary);
  flex-shrink: 0;
}

.fallbackAvatar {
  background: var(--td-brand-color-light);
  color: var(--td-brand-color);
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}
.emptyActionWrap {
  display: flex;
  justify-content: center;
  padding: 8px 12px;
  .emptyActionButton {
    min-width: 140px;
    color: #339af0;
  }
}
</style>

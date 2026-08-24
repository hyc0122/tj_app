<template>
  <div class="uiConfig">
    <t-form labelAlign="top">
      <t-form-item :label="$t('settings.ui.colorMode')">
        <!-- 正式四档：自动 / 浅色 / 深色 / 赛博朋克 -->
        <t-radio-group variant="default-filled" v-model="themeSetting.mode">
          <t-radio-button value="auto">{{ $t("settings.ui.modeAuto") }}</t-radio-button>
          <t-radio-button value="light">{{ $t("settings.ui.modeLight") }}</t-radio-button>
          <t-radio-button value="dark">{{ $t("settings.ui.modeDark") }}</t-radio-button>
          <t-radio-button value="cyberpunk">{{ $t("settings.ui.modeCyberpunk") }}</t-radio-button>
        </t-radio-group>
      </t-form-item>
      <t-form-item :label="$t('settings.ui.primaryColor')">
        <div class="themeColorConfig">
          <button
            v-for="color in presetColors"
            :key="color"
            class="presetColor"
            :class="{ active: normalizeColor(themeSetting.primaryColor) === color }"
            :style="{ backgroundColor: color }"
            type="button"
            :aria-label="$t('settings.ui.primaryColor')"
            @click="themeSetting.primaryColor = color" />
          <t-color-picker v-model="themeSetting.primaryColor" :color-modes="['monochrome']" format="HEX" :enable-alpha="false" />
        </div>
      </t-form-item>
      <t-form-item :label="$t('settings.ui.fontSize')">
        <t-radio-group variant="default-filled" v-model="themeSetting.fontSize">
          <t-radio-button :value="12">{{ $t("settings.ui.fontSizeTiny") }}</t-radio-button>
          <t-radio-button :value="13">{{ $t("settings.ui.fontSizeSmaller") }}</t-radio-button>
          <t-radio-button :value="14">{{ $t("settings.ui.fontSizeSmall") }}</t-radio-button>
          <t-radio-button :value="16">{{ $t("settings.ui.fontSizeDefault") }}</t-radio-button>
          <t-radio-button :value="18">{{ $t("settings.ui.fontSizeLarge") }}</t-radio-button>
          <t-radio-button :value="20">{{ $t("settings.ui.fontSizeLarger") }}</t-radio-button>
          <t-radio-button :value="22">{{ $t("settings.ui.fontSizeHuge") }}</t-radio-button>
        </t-radio-group>
      </t-form-item>
    </t-form>
  </div>
</template>

<script setup lang="ts">
import settingStore from "@/stores/setting";
import {
  applyThemeMode,
  applyThemeColor,
  toggleThemeWithTransition,
  clearDynamicBrandVars,
} from "@/utils/theme";
const { themeSetting } = storeToRefs(settingStore());

const presetColors = ["#000000", "#0052D9", "#2BA471", "#ED7B2F", "#E34D59", "#7B61FF", "#A855F7", "#111111"];

const normalizeColor = (value: string) => {
  const hex = (value || "").trim();
  if (!hex) return "#0052D9";

  const normalized = hex.startsWith("#") ? hex : `#${hex}`;
  const match = /^#[0-9a-fA-F]{6}$/.test(normalized);

  return match ? normalized.toUpperCase() : "#0052D9";
};

watch(
  () => themeSetting.value.mode,
  (mode) => {
    toggleThemeWithTransition(undefined, () => {
      // 切换主题时先清动态品牌变量，再应用模式，避免 cyberpunk ↔ light/dark 残留
      clearDynamicBrandVars();
      applyThemeMode(mode);
      applyThemeColor(normalizeColor(themeSetting.value.primaryColor));
    });
  },
);

const applyFontSize = (size: number) => {
  document.documentElement.style.fontSize = `${size}px`;
};

applyFontSize(themeSetting.value.fontSize);
watch(
  () => [themeSetting.value.mode, themeSetting.value.primaryColor, themeSetting.value.fontSize],
  () => settingStore().schedulePersistAccountAppearance(),
);

watch(
  () => themeSetting.value.fontSize,
  (size) => applyFontSize(size),
);

watch(
  () => themeSetting.value.primaryColor,
  (color) => {
    const normalized = normalizeColor(color);

    if (normalized !== color) {
      themeSetting.value.primaryColor = normalized;
      return;
    }

    applyThemeColor(normalized);
  },
);
</script>

<style lang="scss" scoped>
.themeColorConfig {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.presetColor {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 50%;
  cursor: pointer;
  outline: none;
  position: relative;
  transition: all 0.2s ease;

  &::after {
    content: "";
    position: absolute;
    inset: -4px;
    border-radius: 50%;
    border: 2px solid transparent;
    transition: border-color 0.2s ease;
  }

  &:hover::after {
    border-color: var(--td-component-border, #dcdcdc);
  }

  &.active::after {
    border-color: var(--td-brand-color);
  }

  &:focus-visible::after {
    border-color: var(--td-brand-color);
  }
}
</style>

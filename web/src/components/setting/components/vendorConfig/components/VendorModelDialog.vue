<template>
  <t-dialog
    v-model:visible="modelDialogVisible"
    placement="center"
    width="40vw"
    :header="
      editingModelIndex === null
        ? $t('settings.vendor.addModel')
        : $t('settings.vendor.editModel')
    "
    :mask-closable="false"
    @confirm="handleConfirmModel"
  >
    <div class="addBox">
      <t-form :data="modelFormData" label-align="top">
        <t-form-item name="name" :label="$t('settings.vendor.displayName')">
          <t-input
            v-model="modelFormData.name"
            :placeholder="$t('settings.vendor.displayNamePlaceholder')"
            clearable
          />
        </t-form-item>
        <t-form-item name="modelName" :label="$t('settings.vendor.modelId')">
          <t-input
            v-model="modelFormData.modelName"
            :placeholder="$t('settings.vendor.modelIdPlaceholder')"
            clearable
          />
        </t-form-item>
        <t-form-item name="type" :label="$t('settings.vendor.modelType')">
          <t-select v-model="modelFormData.type">
            <t-option
              v-for="item in modelTypeOptions"
              :key="item.value"
              :value="item.value"
            >
              {{ $t(item.label) }}
            </t-option>
          </t-select>
        </t-form-item>

        <t-form-item
          v-if="modelFormData.type === 'text'"
          name="think"
          :label="$t('settings.vendor.think')"
        >
          <t-radio-group v-model="modelFormData.think">
            <t-radio :value="true">{{ $t("settings.vendor.supported") }}</t-radio>
            <t-radio :value="false">{{ $t("settings.vendor.notSupported") }}</t-radio>
          </t-radio-group>
        </t-form-item>

        <t-form-item
          v-if="modelFormData.type === 'image'"
          name="mode"
          :label="$t('settings.vendor.imageMode')"
        >
          <t-checkbox-group v-model="modelFormData.mode">
            <t-checkbox
              v-for="option in imageModeOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ $t(option.label) }}
            </t-checkbox>
          </t-checkbox-group>
        </t-form-item>

        <template v-if="modelFormData.type === 'video'">
          <t-form-item name="mode" :label="$t('settings.vendor.videoMode')">
            <div class="videoModeEditor">
              <t-checkbox-group v-model="modelFormData.mode">
                <t-checkbox
                  v-for="option in videoModeOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ $t(option.label) }}
                </t-checkbox>
              </t-checkbox-group>
              <div
                v-if="modelFormData.mode.includes('multiReference')"
                class="mixedModeEditor"
              >
                <t-checkbox-group v-model="modelFormData.mixedMode" class="mixedModeGroup">
                  <template v-for="option in referenceOptions" :key="option.value">
                    <t-checkbox :value="option.value">
                      {{ $t(option.label) }}
                    </t-checkbox>
                    <t-input-number
                      v-if="modelFormData.mixedMode.includes(option.value)"
                      v-model="modelFormData.mixedModeCount[option.value]"
                      :min="1"
                      :max="99"
                      size="small"
                      class="mixedModeCount"
                      :placeholder="$t('settings.vendor.count')"
                    />
                  </template>
                </t-checkbox-group>
              </div>
            </div>
          </t-form-item>
          <t-form-item name="audio" :label="$t('settings.vendor.audioOutput')">
            <t-radio-group v-model="modelFormData.audio">
              <t-radio
                v-for="item in audioOptions"
                :key="String(item.value)"
                :value="item.value"
              >
                {{ $t(item.label) }}
              </t-radio>
            </t-radio-group>
          </t-form-item>
          <t-form-item
            name="durationResolutionMap"
            :label="$t('settings.vendor.durationResolution')"
          >
            <div class="drmEditor">
              <div class="drmHeader">
                <div class="drmHeaderIndex"></div>
                <div class="drmHeaderLabel">{{ $t("settings.vendor.durationSec") }}</div>
                <div class="drmHeaderArrow"></div>
                <div class="drmHeaderLabel">{{ $t("settings.vendor.resolution") }}</div>
                <div class="drmHeaderAction"></div>
              </div>
              <div
                v-for="(row, rowIndex) in modelFormData.durationResolutionMap"
                :key="rowIndex"
                class="drmRow"
              >
                <div class="drmRowIndex">{{ rowIndex + 1 }}</div>
                <t-tag-input
                  v-model="row.duration"
                  :placeholder="$t('settings.vendor.enterAndPress')"
                  class="drmInput"
                />
                <div class="drmArrow">→</div>
                <t-tag-input
                  v-model="row.resolution"
                  :placeholder="$t('settings.vendor.enterAndPress')"
                  class="drmInput"
                />
                <t-button
                  variant="text"
                  theme="danger"
                  size="small"
                  :disabled="modelFormData.durationResolutionMap.length === 1"
                  @click="modelFormData.durationResolutionMap.splice(rowIndex, 1)"
                >
                  <template #icon><i-delete theme="outline" /></template>
                </t-button>
              </div>
              <t-button
                class="addDrmRow"
                variant="dashed"
                block
                @click="
                  modelFormData.durationResolutionMap.push({
                    duration: [],
                    resolution: [],
                  })
                "
              >
                <template #icon><i-plus theme="outline" /></template>
                {{ $t("settings.vendor.addDurationResolution") }}
              </t-button>
            </div>
          </t-form-item>
        </template>
      </t-form>
    </div>
  </t-dialog>
</template>

<script setup lang="ts">
import { useVendorConfigContext } from "../vendorConfigContext";

const {
  audioOptions,
  editingModelIndex,
  handleConfirmModel,
  imageModeOptions,
  modelDialogVisible,
  modelFormData,
  modelTypeOptions,
  referenceOptions,
  videoModeOptions,
} = useVendorConfigContext();
</script>

<style lang="scss" scoped src="../styles/vendor-model-dialog.scss"></style>

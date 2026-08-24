<template>
  <div class="modelServe">
    <div class="modelList">
      <div class="listFooter">
        <t-button block theme="primary" @click="handleAddVendor">
          <template #icon><t-icon name="add" /></template>
          {{ $t("settings.vendor.addVendor") }}
        </t-button>
      </div>
      <div v-loading="loading" class="listContent">
        <t-menu
          v-model="activeVendorId"
          theme="light"
        >
          <t-menu-item
            v-for="item in workspaceItems"
            :key="item.id"
            :value="item.id"
            style="position: relative"
            @click="activeVendorId = item.id"
          >
            <template v-if="item.kind === 'configured-vendor' && isValidBase64(item.vendor.icon)" #icon>
              <t-avatar size="24px" shape="round" :image="item.vendor.icon" />
            </template>
            <span>{{ item.kind === "native-dreamina" ? $t("settings.menu.dreaminaCli") : item.vendor.name }}</span>
            <t-switch
              v-if="item.kind === 'configured-vendor'"
              v-model="item.vendor.enable"
              :custom-value="[1, 0]"
              style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); z-index: 10"
              @click.stop
              @change="(value: any) => onChange(item.vendor, value)"
            />
          </t-menu-item>
        </t-menu>
      </div>
    </div>

    <DreaminaProviderPanel v-if="isNativeDreamina" class="modelParameter" />
    <div v-else-if="currentVendor" class="modelParameter">
      <div class="configuration">
        <t-form :data="currentVendor" label-align="top">
          <div class="infoBox ac jb">
            <span class="idBox">#{{ currentVendor.id }}</span>
            <span class="author">@{{ currentVendor.author }}</span>
          </div>
          <t-alert
            v-if="needsUpdate(currentVendor)"
            theme="warning"
            :message="$t('settings.vendor.msg.vendorNeedsUpdate')"
            style="margin-bottom: 12px"
          />
          <t-form-item>
            <MdPreview
              v-model="currentVendor.description"
              :theme="resolveMdEditorTheme(themeSetting.mode)"
            />
          </t-form-item>
          <!-- 凭据区仅在响应式 loaded 状态渲染；与模型列表独立，模型始终可显示 -->
          <template v-if="vendorSecretsLoaded || vendorLoadState.state === 'loaded'">
            <t-form-item
              v-for="input in orderedInputs"
              :key="input.key"
              :name="input.key"
            >
              <template #label>
                <span :class="input.required ? 'requiredLabel' : ''">
                  {{ input.label }}
                  <template v-if="input.required">
                    <span class="requiredMark">*</span>
                    <span class="requiredText">{{ $t("settings.vendor.required") }}</span>
                  </template>
                </span>
              </template>
              <t-input
                v-model="currentVendor.inputValues[input.key]"
                :type="getVisibleInputType(input.type)"
                :disabled="Boolean(input.disabled)"
                :placeholder="getInputPlaceholder(input)"
                clearable
                @blur="onBlurFn"
              >
                <template #prefix-icon>
                  <t-icon :name="getInputIcon(input.type)" />
                </template>
              </t-input>
              <template v-if="getInputPlaceholder(input)" #help>
                <span class="inputHelp">{{ getInputPlaceholder(input) }}</span>
              </template>
            </t-form-item>
            <p v-if="vendorSaveState === 'saving'" class="vendorSaveHint">保存中…</p>
            <p v-else-if="vendorSaveState === 'error'" class="vendorSaveError">
              {{ vendorSaveError || $t("settings.vendor.msg.updateFailed") }}
            </p>
          </template>
          <div v-else-if="vendorLoadState.state === 'error'" class="vendorLoadError">
            <p>{{ vendorLoadState.message || $t("settings.vendor.msg.loadInputsFailed") }}</p>
            <t-button size="small" variant="outline" @click="retryVendorLoad">
              {{ $t("settings.vendor.msg.operationFailed") }}
            </t-button>
          </div>
          <t-loading v-else-if="vendorLoadState.state === 'loading'" size="small" text="加载中" />
          <!-- idle：请选择供应商；只有 error 才显示加载失败文案；无供应商不走失败文案 -->
          <t-empty v-else :description="$t('settings.vendor.msg.selectVendorFirst')" />

          <div class="jb ac">
            <h4 class="sectionTitle">{{ $t("settings.vendor.modelSettings") }}</h4>
            <t-button variant="outline" size="small" @click="handleAddModel">
              <template #icon><i-plus theme="outline" /></template>
              {{ $t("settings.vendor.addManually") }}
            </t-button>
          </div>
          <!-- 模型卡片：显式业务悬浮类，不作用于输入/弹层 -->
          <t-card
            v-for="(item, index) in vendorModels"
            :key="index"
            class="modelCard module-interactive"
          >
            <div class="topInfo jb ac">
              <div class="modelCardNameWrap">
                <t-avatar
                  v-if="getModelLogo(item.modelName)"
                  size="24px"
                  shape="round"
                  :image="getModelLogo(item.modelName)!"
                />
                <span class="modelCardName">{{ item.name }}</span>
              </div>
              <div class="actionBtns">
                <t-button size="small" variant="text" @click="handleTestModel(item)">
                  <template #icon><i-lightning theme="outline" /></template>
                  {{ $t("settings.vendor.testModel") }}
                </t-button>
                <t-button variant="text" size="small" @click="handleEditModel(item)">
                  <template #icon><i-pencil theme="outline" /></template>
                  {{ $t("settings.vendor.edit") }}
                </t-button>
                <t-button
                  variant="text"
                  size="small"
                  theme="danger"
                  @click="handleDeleteModel(item.modelName)"
                >
                  <template #icon><i-delete theme="outline" /></template>
                  {{ $t("settings.vendor.delete") }}
                </t-button>
              </div>
            </div>
            <div class="tags">
              <t-tag theme="primary">{{ $t(getTypeLabel(item.type)) }}</t-tag>
              <t-tag
                v-if="item.type === 'text' && item.think"
                variant="light"
              >
                {{ $t("settings.vendor.think") }}
              </t-tag>
              <template
                v-for="(mode, modeIndex) in (item as any).mode"
                :key="modeIndex"
              >
                <t-tag v-if="!Array.isArray(mode)" variant="light">
                  {{ getModeLabel(mode, item.type) }}
                </t-tag>
                <t-tag
                  v-for="(nestedMode, nestedIndex) in mode"
                  v-else
                  :key="nestedIndex"
                  variant="light"
                >
                  {{ getModeLabel(nestedMode, item.type) }}
                </t-tag>
              </template>
            </div>
          </t-card>
        </t-form>
        <div class="updateAction">
          <t-button theme="danger" :loading="updating" @click="handleDeleteVendor">
            {{ $t("settings.vendor.deleteVendor") }}
          </t-button>
          <t-button theme="default" :loading="updating || codeLoading" @click="handleEditVendorCode">
            {{ $t("settings.vendor.editCode") }}
          </t-button>
          <!-- 原页面暂未启用的配置更新入口继续保留，避免后续恢复时丢失 i18n 语义。 -->
          <!-- <t-button theme="primary">{{ $t("settings.vendor.updateConfig") }}</t-button> -->
        </div>
      </div>
    </div>

    <TextModelTest
      v-if="testingModel?.type === 'text' && textTestVisible"
      v-model:model-visible="textTestVisible"
      :vendor-id="currentVendor!.id"
      :model-name="testingModel.modelName"
    />
    <ImageModelTest
      v-if="testingModel?.type === 'image' && imageTestVisible"
      v-model:model-visible="imageTestVisible"
      :vendor-id="currentVendor!.id"
      :model-name="testingModel.modelName"
      :supported-modes="testingModel.mode || []"
    />
    <VideoModelTest
      v-if="testingModel?.type === 'video' && videoTestVisible"
      v-model:model-visible="videoTestVisible"
      :vendor-id="currentVendor!.id"
      :model-name="testingModel.modelName"
      :raw-modes="testingModel.mode || []"
    />
  </div>
</template>

<script setup lang="ts">
import { resolveMdEditorTheme } from "@/utils/theme";
import { MdPreview } from "md-editor-v3";
import TextModelTest from "../../vendorTest/TextModelTest.vue";
import ImageModelTest from "../../vendorTest/ImageModelTest.vue";
import VideoModelTest from "../../vendorTest/VideoModelTest.vue";
import { useVendorConfigContext } from "../vendorConfigContext";
import DreaminaProviderPanel from "./DreaminaProviderPanel.vue";

const {
  activeVendorId,
  codeLoading,
  currentVendor,
  workspaceItems,
  isNativeDreamina,
  getInputIcon,
  getInputPlaceholder,
  getVisibleInputType,
  getModeLabel,
  getModelLogo,
  getTypeLabel,
  handleAddModel,
  handleAddVendor,
  handleDeleteModel,
  handleDeleteVendor,
  handleEditModel,
  handleEditVendorCode,
  handleTestModel,
  imageTestVisible,
  isValidBase64,
  loading,
  needsUpdate,
  onBlurFn,
  onChange,
  orderedInputs,
  optionalInputs,
  requiredInputs,
  retryVendorLoad,
  testingModel,
  textTestVisible,
  themeSetting,
  updating,
  vendorList,
  vendorLoadState,
  vendorModels,
  vendorSaveError,
  vendorSaveState,
  vendorSecretsLoaded,
  videoTestVisible,
} = useVendorConfigContext();
</script>

<style lang="scss" scoped src="../styles/vendor-workspace.scss"></style>

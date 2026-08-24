<template>
  <t-dialog
    v-model:visible="vendorDialogVisible"
    width="30vw"
    placement="center"
    top="10vh"
    :footer="false"
    :header="$t('settings.vendor.addVendorDialog')"
    :mask-closable="false"
  >
    <div class="data">
      <t-radio-group v-model="addMode" variant="default-filled">
        <t-radio-button value="importAdd">通过文件导入</t-radio-button>
        <t-radio-button value="linkAdd">通过链接添加</t-radio-button>
        <t-radio-button value="codeAdd">通过代码添加</t-radio-button>
      </t-radio-group>
      <div v-if="addMode === 'linkAdd'" class="linkAdd">
        <t-alert theme="warning" style="margin-bottom: 20px">
          请填写 TypeScript 代码文件的链接（.ts 文件），不要填 API
          地址或其他无关链接。确认后天将漫创
          会自动加载该代码，请确保链接来源可信。
        </t-alert>
        <t-input
          v-model="link"
          :placeholder="$t('settings.vendor.linkAddPlaceholder')"
        />
        <div class="linkAction">
          <t-button
            :loading="linkReading"
            :disabled="!link.trim()"
            @click="linkRead"
          >
            {{ $t("settings.vendor.linkAdd") }}
          </t-button>
        </div>
      </div>
      <div v-if="addMode === 'importAdd'" class="importAdd">
        <div
          class="uploadArea"
          @click="triggerUpload"
          @dragover.prevent
          @drop.prevent="handleDrop"
        >
          <t-upload
            ref="uploadRef"
            v-model="fileList"
            theme="file"
            :multiple="false"
            :max="1"
            accept=".ts"
            :before-upload="handleBeforeUpload"
            :request-method="requestMethod"
            style="display: none"
          />
          <div class="dragIcon">
            <i-upload-one
              theme="outline"
              size="32"
              fill="var(--td-brand-color)"
            />
          </div>
          <p class="uploadText">{{ $t("workbench.novel.import.importAdd") }}</p>
          <p class="uploadHint">{{ $t("workbench.novel.import.limit") }}</p>
        </div>
      </div>
      <div v-if="addMode === 'codeAdd'" class="codeAdd"></div>
    </div>
  </t-dialog>

  <t-dialog
    v-model:visible="codeDialogVisible"
    width="70vw"
    placement="center"
    top="10vh"
    :header="$t('settings.vendor.code')"
    :mask-closable="false"
    @confirm="handleConfirmVendor"
  >
    <div class="editorToolbar">
      <div class="editorInfo">
        <t-icon name="info-circle" size="16px" />
        <span>{{ $t("settings.vendor.codeEditorInfo") }}</span>
      </div>
      <div class="editorActions">
        <t-button
          variant="text"
          size="small"
          @click="handleResetVendorCode"
        >
          <template #icon><t-icon name="rollback" /></template>
          {{ $t("settings.vendor.reset") }}
        </t-button>
        <t-button
          variant="outline"
          size="small"
          @click="fileInputRef?.click()"
        >
          <template #icon><t-icon name="upload" /></template>
          {{ $t("settings.vendor.importFile") }}
        </t-button>
        <input
          ref="fileInputRef"
          type="file"
          accept=".ts,.js,.txt,.json"
          style="display: none"
          @change="handleFileChange"
        />
      </div>
    </div>
    <div class="editorWrapper">
      <CodeEditor
        v-model:value="vendorCode"
        language="typescript"
        :theme="monacoTheme"
        :height="600"
        :options="editorOptions"
      />
    </div>
  </t-dialog>
</template>

<script setup lang="ts">
import { CodeEditor } from "monaco-editor-vue3";
import settingStore from "@/stores/setting";
import { resolveMonacoTheme } from "@/utils/theme";
import VENDOR_CODE_TEMPLATE from "@/lib/vendorTemplate.ts?raw";
import { useVendorConfigContext } from "../vendorConfigContext";

const { themeSetting } = storeToRefs(settingStore());
// Monaco 仅支持 vs/vs-dark；cyberpunk 映射为 vs-dark，禁止传入无效主题值
const monacoTheme = computed(() => resolveMonacoTheme(themeSetting.value.mode));

const {
  addMode,
  codeDialogVisible,
  editorOptions,
  fileInputRef,
  fileList,
  handleBeforeUpload,
  handleConfirmVendor,
  handleDrop,
  handleFileChange,
  handleResetVendorCode,
  link,
  linkRead,
  linkReading,
  requestMethod,
  triggerUpload,
  uploadRef,
  vendorCode,
  vendorDialogVisible,
} = useVendorConfigContext();
</script>

<style lang="scss" scoped src="../styles/vendor-import-dialogs.scss"></style>

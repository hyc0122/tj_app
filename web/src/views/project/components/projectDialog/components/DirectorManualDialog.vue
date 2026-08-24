<template>
  <t-dialog
    v-model:visible="directorDialogVisible"
    class="artStyleDialog"
    :header="
      editingDirectorManual
        ? $t('workbench.project.dialog.editingDirectorManual')
        : $t('workbench.project.dialog.newDirecorManualTitle')
    "
    width="90vw"
    placement="center"
    :confirm-btn="$t('workbench.project.dialog.ok')"
    :cancel-btn="$t('workbench.project.dialog.cancel')"
    @confirm="handleDirectorManualSubmit"
    @close-btn-click="resetVisualManualDialog"
    @cancel="resetVisualManualDialog"
  >
    <t-loading :loading="loading">
      <t-form label-align="top">
        <t-form-item>
          <div class="nameAndCoverRow">
            <div class="nameField">
              <label class="fieldLabel">
                {{ $t("workbench.project.dialog.directorManualName") }}
              </label>
              <t-input
                v-model="directorManualForm.name"
                :placeholder="$t('workbench.project.dialog.directorManualNamePh')"
              />
            </div>
            <div class="mdFileLocation">
              <label class="fieldLabel">
                {{ $t("workbench.project.dialog.directorFile") }}
              </label>
              <t-input
                v-model="directorManualForm.directorManual"
                :disabled="!!editingDirectorManual"
              />
            </div>
            <div class="coverField">
              <label class="fieldLabel">
                {{ $t("workbench.project.dialog.directorManualCover") }}
              </label>
              <div class="coverUploadArea multiCoverUploadArea">
                <div
                  v-for="(image, index) in directorManualForm.images"
                  :key="index"
                  class="coverPreview"
                >
                  <img :src="image" class="coverImg" />
                  <div
                    class="coverImgRemove"
                    @click="removeVisualManualCover(index)"
                  >
                    <i-close size="10" />
                  </div>
                </div>
                <div
                  class="coverUploadTrigger"
                  @click="triggerDirectorManualCoverUpload"
                >
                  <input
                    ref="visualManualCoverInputRef"
                    type="file"
                    accept="image/*"
                    multiple
                    style="display: none"
                    @change="handleDirectorManualCoverFileChange"
                  />
                  <i-plus size="24" />
                  <span>{{ $t("workbench.project.dialog.uploadCover") }}</span>
                </div>
              </div>
            </div>
          </div>
        </t-form-item>
        <t-form-item :label="$t('workbench.project.dialog.directorManualPrompt')">
          <div class="promptEditorWrapper">
            <t-tabs
              :value="directorManualTabValue"
              size="medium"
              @change="(value) => (directorManualTabValue = value)"
            >
              <t-tab-panel
                v-for="tab in directorManualTabData"
                :key="tab.value"
                :value="tab.value"
                :label="tab.label"
              >
                <MdEditor
                  v-model="tab.data"
                  :theme="
                    resolveMdEditorTheme(themeSetting.mode)
                  "
                  :toolbars="promptToolbars"
                  :footers="[]"
                  :placeholder="$t('workbench.project.dialog.promptPlaceholder')"
                  style="height: 30vh; margin-top: 5px"
                  @on-upload-img="() => {}"
                />
              </t-tab-panel>
            </t-tabs>
          </div>
        </t-form-item>
      </t-form>
    </t-loading>
  </t-dialog>
</template>

<script setup lang="ts">
import { resolveMdEditorTheme } from "@/utils/theme";
import { MdEditor } from "md-editor-v3";
import { useProjectDialogContext } from "../projectDialogContext";

const {
  directorDialogVisible,
  directorManualForm,
  directorManualTabData,
  directorManualTabValue,
  editingDirectorManual,
  handleDirectorManualCoverFileChange,
  handleDirectorManualSubmit,
  loading,
  promptToolbars,
  removeVisualManualCover,
  resetVisualManualDialog,
  themeSetting,
  visualManualCoverInputRef,
} = useProjectDialogContext();

// 保持旧弹窗复用视觉手册上传 input 的行为，避免拆分时改变交互顺序。
const triggerDirectorManualCoverUpload = () =>
  visualManualCoverInputRef.value?.click();
</script>

<style lang="scss" scoped src="../styles/manual-dialog.scss"></style>

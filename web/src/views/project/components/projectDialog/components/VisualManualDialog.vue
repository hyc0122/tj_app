<template>
  <t-dialog
    v-model:visible="visualManualDialogVisible"
    class="artStyleDialog"
    :header="
      editingVisualManual
        ? $t('workbench.project.dialog.editVisualManualTitle')
        : $t('workbench.project.dialog.newVisualManualTitle')
    "
    width="90vw"
    placement="center"
    :confirm-btn="$t('workbench.project.dialog.ok')"
    :cancel-btn="$t('workbench.project.dialog.cancel')"
    @confirm="handleVisualManualSubmit"
    @close-btn-click="resetDirectorManualDialog"
    @cancel="resetDirectorManualDialog"
  >
    <t-loading :loading="loading">
      <t-form label-align="top">
        <t-form-item>
          <div class="nameAndCoverRow">
            <div class="nameField">
              <label class="fieldLabel">
                {{ $t("workbench.project.dialog.visualManualName") }}
              </label>
              <t-input
                v-model="visualManualForm.name"
                :placeholder="$t('workbench.project.dialog.visualManualNamePh')"
              />
            </div>
            <div class="mdFileLocation">
              <label class="fieldLabel">
                {{ $t("workbench.project.dialog.mdFile") }}
              </label>
              <t-input
                v-model="visualManualForm.stylePath"
                :disabled="!!editingVisualManual"
              />
            </div>
            <div class="coverField">
              <label class="fieldLabel">
                {{ $t("workbench.project.dialog.visualManualCover") }}
              </label>
              <div class="coverUploadArea multiCoverUploadArea">
                <div
                  v-for="(image, index) in visualManualForm.images"
                  :key="index"
                  class="coverPreview"
                >
                  <img
                    :src="image"
                    class="coverImg"
                    style="cursor: pointer"
                    @click.stop="handlePreview(image)"
                  />
                  <div
                    class="coverImgRemove"
                    @click="removeVisualManualCover(index)"
                  >
                    <i-close size="10" />
                  </div>
                </div>
                <div
                  class="coverUploadTrigger"
                  @click="triggerVisualManualCoverUpload"
                >
                  <input
                    ref="visualManualCoverInputRef"
                    type="file"
                    accept="image/*"
                    multiple
                    style="display: none"
                    @change="handleVisualManualCoverFileChange"
                  />
                  <i-plus size="24" />
                  <span>{{ $t("workbench.project.dialog.uploadCover") }}</span>
                </div>
              </div>
            </div>
          </div>
        </t-form-item>
        <t-form-item :label="$t('workbench.project.dialog.visualManualPrompt')">
          <div class="promptEditorWrapper">
            <t-tabs
              :value="visualManualTabValue"
              size="medium"
              @change="(value) => (visualManualTabValue = value)"
            >
              <t-tab-panel
                v-for="tab in visualManualTabData"
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
  editingVisualManual,
  handlePreview,
  handleVisualManualCoverFileChange,
  handleVisualManualSubmit,
  loading,
  promptToolbars,
  removeVisualManualCover,
  resetDirectorManualDialog,
  themeSetting,
  triggerVisualManualCoverUpload,
  visualManualCoverInputRef,
  visualManualDialogVisible,
  visualManualForm,
  visualManualTabData,
  visualManualTabValue,
} = useProjectDialogContext();
</script>

<style lang="scss" scoped src="../styles/manual-dialog.scss"></style>

<template>
  <t-dialog
    v-model:visible="addProjectShow"
    placement="center"
    :header="
      isEdit
        ? $t('workbench.project.dialog.editTitle')
        : $t('workbench.project.dialog.addTitle')
    "
    class="projectFormDialog"
    width="min(1180px, calc(100vw - 48px))"
    :confirm-btn="
      isEdit
        ? $t('workbench.project.dialog.save')
        : $t('workbench.project.dialog.ok')
    "
    :cancel-btn="$t('workbench.project.dialog.cancel')"
    :confirm-loading="submitting"
    @confirm="handleOk"
    @close-btn-click="handleCancel"
    @cancel="handleCancel"
  >
    <div class="formColumns">
      <div class="formLeft">
        <t-form :data="formState" label-align="top">
          <t-form-item :label="$t('projectScope.personal')">
            <ProjectScopeSelector
              v-model:scope="formState.scope"
              v-model:team-uuid="formState.teamUuid"
              :teams="creatableTeams"
              :disabled="isEdit"
            />
          </t-form-item>
          <t-form-item :label="$t('workbench.project.dialog.projectType')">
            <t-select
              v-model="formState.projectType"
              :placeholder="$t('workbench.project.dialog.selectType')"
              :disabled="isEdit"
            >
              <t-option
                key="novel"
                :label="$t('workbench.project.dialog.basedOnNovel')"
                value="novel"
              />
              <t-option
                key="script"
                :label="$t('workbench.project.dialog.basedOnScript')"
                value="script"
              />
              <t-option
                key="storyboard"
                :label="$t('workbench.project.dialog.basedOnStoryboard')"
                value="storyboard"
              />
            </t-select>
          </t-form-item>
          <t-form-item
            v-if="formState.projectType === 'storyboard'"
            :label="$t('workbench.project.dialog.assetMode')"
          >
            <t-radio-group v-model="formState.assetMode" :disabled="isEdit">
              <t-radio value="independent" :label="$t('workbench.project.dialog.assetIndependent')" />
              <t-radio value="shared" :label="$t('workbench.project.dialog.assetShared')" />
            </t-radio-group>
          </t-form-item>
          <t-form-item
            v-if="formState.projectType === 'storyboard' && (formState.assetMode === 'shared' || (isEdit && formState.assetSourceProjectUuid))"
            :label="$t('workbench.project.dialog.assetSource')"
          >
            <t-select
              v-model="formState.assetSourceProjectUuid"
              :disabled="isEdit"
              :placeholder="$t('workbench.project.dialog.assetSourcePh')"
            >
              <t-option
                v-if="formState.assetSourceProjectUuid && !sourceProjects.some((item) => item.projectUuid === formState.assetSourceProjectUuid)"
                :value="formState.assetSourceProjectUuid"
                :label="formState.assetSourceProjectUuid"
              />
              <t-option
                v-for="item in sourceProjects"
                :key="item.projectUuid"
                :value="item.projectUuid"
                :label="item.name"
              />
            </t-select>
          </t-form-item>
          <t-form-item :label="$t('workbench.project.dialog.defaultLanguage')">
            <t-select
              v-model="formState.defaultLanguage"
              :placeholder="$t('workbench.project.dialog.defaultLanguagePh')"
            >
              <t-option value="zh-CN" :label="$t('workbench.project.dialog.langZhCN')" />
              <t-option value="en" :label="$t('workbench.project.dialog.langEn')" />
              <t-option value="ja_JP" :label="$t('workbench.project.dialog.langJa')" />
            </t-select>
          </t-form-item>
          <t-form-item :label="$t('workbench.project.dialog.artStyle')">
            <t-input
              v-model="formState.artStyle"
              :placeholder="$t('workbench.project.dialog.selectArtStyle')"
            />
          </t-form-item>
          <t-form-item :label="$t('workbench.project.dialog.projectName')">
            <t-input
              v-model="formState.name"
              :placeholder="$t('workbench.project.dialog.projectNamePh')"
            />
          </t-form-item>
          <t-form-item :label="$t('workbench.project.dialog.novelType')">
            <t-input
              v-model="formState.type"
              :placeholder="$t('workbench.project.dialog.novelTypePh')"
            />
          </t-form-item>
          <t-form-item :label="$t('workbench.project.dialog.modelData')">
            <div class="ac modelRow">
              <modelSelect v-model="formState.imageModel" type="image" />
              <t-select
                v-model="formState.imageQuality"
                class="paramSelect ml-5"
                :placeholder="$t('workbench.production.editImage.quality')"
              >
                <t-option value="1K" label="1K" />
                <t-option value="2K" label="2K" />
                <t-option value="4K" label="4K" />
              </t-select>
            </div>
          </t-form-item>
          <t-form-item :label="$t('workbench.project.dialog.videoModelData')">
            <div class="ac modelRow">
              <modelSelect
                v-model="formState.videoModel"
                type="video"
                :change-config="true"
                @change="changeFn"
              />
              <t-select
                v-model="formState.mode"
                class="paramSelect ml-5"
                :placeholder="$t('workbench.production.editImage.mode')"
              >
                <t-option
                  v-for="value in mode"
                  :key="value.value"
                  :value="value.value"
                  :label="value.label"
                />
              </t-select>
            </div>
          </t-form-item>
          <t-form-item :label="$t('workbench.project.dialog.videoRatio')">
            <t-select v-model="formState.videoRatio" :options="RATIO_OPTIONS" />
          </t-form-item>
          <t-form-item :label="$t('workbench.project.dialog.novelIntro')">
            <t-textarea
              v-model="formState.intro"
              :autosize="{ minRows: 3, maxRows: 6 }"
              :placeholder="$t('workbench.project.dialog.novelIntroPh')"
            />
          </t-form-item>
        </t-form>
      </div>

      <div class="formRight">
        <t-form label-align="top">
          <t-form-item>
            <ProjectManualPicker
              root-class="artStylePicker"
              header-class="artStyleHeader"
              :title="$t('workbench.project.dialog.visualManual')"
              :add-label="$t('workbench.project.dialog.newVisualManual')"
              :loading="visualManualLoading"
              :error="visualManualError"
              :items="visualManualOptions"
              :selected="formState.artStyle"
              :item-key="visualManualKey"
              @add="openVisualManualDialog()"
              @retry="fetchVisualManuals"
              @select="formState.artStyle = $event"
              @edit="openVisualManualDialog($event)"
              @remove="deleteVisualManual"
              @preview="handlePreview"
            />
          </t-form-item>
          <t-form-item>
            <ProjectManualPicker
              root-class="directorManual"
              header-class="directorManualHeader"
              :title="$t('workbench.project.dialog.directorManual')"
              :add-label="$t('workbench.project.dialog.addDirectorManual')"
              :loading="directorManualLoading"
              :error="directorManualError"
              :items="directorManualOptions"
              :selected="formState.directorManual"
              :item-key="directorManualKey"
              @add="openDirectorManualDialog()"
              @retry="queryDirectorManual"
              @select="formState.directorManual = $event"
              @edit="openDirectorManualDialog($event)"
              @remove="deleteDirectorManual"
              @preview="handlePreview"
            />
          </t-form-item>
        </t-form>
      </div>
    </div>
  </t-dialog>
</template>

<script setup lang="ts">
import modelSelect from "@/components/modelSelect.vue";
import ProjectScopeSelector from "../../ProjectScopeSelector.vue";
import { useProjectDialogContext } from "../projectDialogContext";
import ProjectManualPicker from "./ProjectManualPicker.vue";

const {
  RATIO_OPTIONS,
  addProjectShow,
  changeFn,
  creatableTeams,
  deleteDirectorManual,
  deleteVisualManual,
  directorManualError,
  directorManualLoading,
  directorManualOptions,
  fetchVisualManuals,
  formState,
  handleCancel,
  handleOk,
  handlePreview,
  isEdit,
  mode,
  openDirectorManualDialog,
  openVisualManualDialog,
  queryDirectorManual,
  sourceProjects,
  submitting,
  visualManualError,
  visualManualLoading,
  visualManualOptions,
} = useProjectDialogContext();

function visualManualKey(item: { stylePath?: string }) {
  return String(item.stylePath ?? "");
}

function directorManualKey(item: { directorManual?: string }) {
  return String(item.directorManual ?? "");
}
</script>

<style lang="scss" scoped src="../styles/project-form-dialog.scss"></style>

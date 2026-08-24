<template>
  <div class="cornerScape f" data-workspace="corner-scape">
    <div class="left">
      <!-- 左侧批处理面板：大面板克制缩放 -->
      <t-card shadow class="card module-interactive--panel">
        <template #title>
          {{ $t("workbench.cornerScape.batchSettings") }}
          <t-tag size="small" theme="primary" variant="light" style="margin-left: 8px">{{ dataList.length }}</t-tag>
        </template>
        <CornerScapeAssetActions @changed="handleLocalAssetsChanged" />
        <t-form labelAlign="top">
          <t-form-item :label="$t('workbench.cornerScape.quickActions')">
            <div class="quickActions">
              <t-button theme="primary" variant="outline" @click="selectAll">{{ $t("workbench.cornerScape.selectAll") }}</t-button>
              <t-button theme="primary" variant="outline" @click="selectPromptEmpty()">{{ $t("workbench.cornerScape.selectPromptEmpty") }}</t-button>
              <t-button theme="primary" variant="outline" @click="selectByState('')">{{ $t("workbench.cornerScape.selectUngenerated") }}</t-button>
              <t-button theme="primary" variant="outline" @click="selectByState('已完成')">
                {{ $t("workbench.cornerScape.selectGenerated") }}
              </t-button>
              <t-button theme="primary" variant="outline" @click="selectByState('生成失败')">{{ $t("workbench.cornerScape.selectFailed") }}</t-button>
              <t-button theme="primary" variant="outline" @click="toggleSelectAll">{{ $t("workbench.cornerScape.invertSelection") }}</t-button>
              <t-button theme="primary" variant="outline" @click="clearSelection">{{ $t("workbench.cornerScape.clearSelection") }}</t-button>
              <t-image-viewer :images="previewImages" :closeOnEscKeydown="true" :closeOnOverlay="true">
                <template #trigger="{ open }">
                  <t-button theme="primary" variant="outline" :disabled="!hasPreviewImages" @click="hasPreviewImages && open()">
                    {{ $t("workbench.cornerScape.batchPreview") }}
                  </t-button>
                </template>
              </t-image-viewer>
            </div>
          </t-form-item>
          <t-form-item :label="$t('workbench.cornerScape.assetTypeFilter')">
            <t-checkbox-group @change="onChangeFn" v-model="checkboxValue" :options="translatedOptions" class="filterGroup" />
          </t-form-item>

          <t-form-item :label="$t('workbench.cornerScape.genModel')">
            <modelSelect v-model="selectValue" :type="`image`" />
          </t-form-item>
          <t-form-item :label="$t('workbench.cornerScape.resolution')">
            <t-select
              v-model="resolution"
              :placeholder="$t('workbench.cornerScape.resolutionPh')"
              :options="[
                { label: '1K', value: '1K' },
                { label: '2K', value: '2K' },
                { label: '4K', value: '4K' },
              ]"></t-select>
          </t-form-item>
          <t-form-item :label="$t('workbench.cornerScape.textPromptInput')">
            <t-textarea v-model="otherTextPrompt" :placeholder="$t('workbench.cornerScape.textPromptPh')"></t-textarea>
          </t-form-item>
          <t-form-item>
            <div class="btnGap ac">
              <div class="selectedInfo" v-if="selectedIds.length > 0">
                <t-tag size="medium" theme="primary" variant="light">
                  {{ $t("workbench.cornerScape.selectedCount", { count: selectedIds.length }) }}
                </t-tag>
              </div>
              <div class="ac jb" style="width: 100%">
                <t-button theme="primary" block @click="batchGenerationPrompt">{{ $t("workbench.cornerScape.batchGenerationPrompt") }}</t-button>
                <t-button theme="primary" style="margin-left: 10px" block @click="batchSelectBindAudio">
                  {{ $t("workbench.cornerScape.batchBingAudio") }}
                </t-button>
              </div>
              <t-button theme="primary" block @click="batchGenerationImage">
                {{ $t("workbench.cornerScape.startBatch") }}
              </t-button>
            </div>
          </t-form-item>
        </t-form>
      </t-card>
    </div>
    <div class="content">
      <!-- 导演手册/场景资产瓦片：小卡片悬浮 -->
      <t-card v-show="dataList.length > 0" shadow class="card module-interactive" v-for="item in dataList" :key="item.id" @click="openDrawer(item)" tabindex="0" @keydown.enter.prevent="openDrawer(item)">
        <div class="imageBox">
          <t-checkbox class="selectBox" :checked="selectedIds.includes(item.id)" @click.stop @change="toggleSelect(item.id)" />
          <div class="cancelGeneration" @click.stop="cancelGenerationFn(item)" v-if="item.state === '生成中'">
            <t-tag theme="danger" size="small">
              {{ $t("workbench.cornerScape.cancelGeneration") }}
            </t-tag>
          </div>
          <t-empty v-if="!item.state && item.promptState !== '生成中'" type="maintenance" :title="$t('workbench.cornerScape.waitingGen')" />
          <div v-else-if="item.state === '生成中' || item.promptState === '生成中' || item.audioBindState == '生成中'" class="generatingBox">
            <t-loading />
            <span class="generatingText">
              {{ item.audioBindState === "生成中" ? $t("workbench.cornerScape.audioState") : $t("workbench.cornerScape.generating") }}
            </span>
          </div>
          <t-popup :content="item.errorReason" v-else-if="item.state === '生成失败'">
            <t-empty type="fail" :title="$t('workbench.cornerScape.genFailed')" />
          </t-popup>
          <t-image v-else class="image" :src="item.filePath ?? undefined" fit="contain" :preview="true" :lazy="true">
            <template #error>
              <t-empty type="fail" :title="$t('workbench.cornerScape.imageError')" />
            </template>
            <template #overlayContent>
              <div class="imageToolsWrap">
                <ImageTools :src="item.filePath!" position="br" />
              </div>
            </template>
          </t-image>
        </div>
        <div class="infoBox">
          <div class="title ac jb">
            {{ item.name }}
            <t-tag size="small" variant="outline" theme="success" v-if="item.prompt">已生成提示词</t-tag>
            <t-tag size="small" variant="outline" theme="danger" v-else>未生成提示词</t-tag>
          </div>
          <div class="meta">
            <t-tag size="small" variant="light-outline" theme="warning" class="typeTag">
              {{
                item.type === "role"
                  ? $t("workbench.cornerScape.typeRole")
                  : item.type === "scene"
                    ? $t("workbench.cornerScape.typeScene")
                    : item.type === "tool"
                      ? $t("workbench.cornerScape.typeTool")
                      : $t("workbench.cornerScape.typeUnknown")
              }}
            </t-tag>
            <t-tag size="small" variant="outline" class="stateTag" v-if="item.model">
              {{ item.model }}
            </t-tag>
            <t-tag size="small" variant="outline" v-if="item.resolution">
              {{ item.resolution }}
            </t-tag>
          </div>
          <div class="prompt" v-if="item.describe">
            {{
              item.type === "role"
                ? $t("workbench.cornerScape.typeRole")
                : item.type === "scene"
                  ? $t("workbench.cornerScape.typeScene")
                  : item.type === "tool"
                    ? $t("workbench.cornerScape.typeTool")
                    : $t("workbench.cornerScape.typeUnknown")
            }}{{ $t("workbench.cornerScape.descriptionSuffix") }}{{ item.describe }}
          </div>
          <div v-if="item.relepedAudio.length" class="audioList" data-role-audio-list>
            <span v-for="audio in item.relepedAudio" :key="audio.id" class="audioList__item">
              <t-tag size="small" variant="outline" theme="primary">{{ audio.name }}</t-tag>
              <button
                v-if="audio.src"
                type="button"
                data-action="preview-role-audio"
                :data-audio-id="audio.id"
                @click.stop="previewAudio(audio)"
              >试听音色</button>
            </span>
          </div>
        </div>
      </t-card>
      <t-empty v-if="dataList.length === 0" type="empty" :title="$t('workbench.cornerScape.operateScriptFirst')" />
      <t-drawer
        :closeBtn="true"
        closeOnEscKeydown
        :showOverlay="false"
        :footer="false"
        v-model:visible="drawerVisible"
        data-panel="asset-detail"
        size="520px"
      >
        <template #header>
          <div class="drawerHeader">
            <span>{{ currentItem?.name }} - {{ $t("workbench.cornerScape.individualConfig") }}</span>
            <t-tag size="medium" variant="light-outline" theme="warning">
              {{
                currentItem?.type === "role"
                  ? $t("workbench.cornerScape.typeRole")
                  : currentItem?.type === "scene"
                    ? $t("workbench.cornerScape.typeScene")
                    : currentItem?.type === "tool"
                      ? $t("workbench.cornerScape.typeTool")
                      : $t("workbench.cornerScape.typeUnknown")
              }}
            </t-tag>
          </div>
        </template>
        <div v-if="currentItem" class="drawerImageBox" data-field="asset-main-image">
          <t-empty v-if="!currentItem.state" type="maintenance" :title="$t('workbench.cornerScape.waitingGen')" />
          <div v-else-if="currentItem.state === '生成中'" class="generatingBox">
            <t-loading />
            <span class="generatingText">{{ $t("workbench.cornerScape.generating") }}</span>
          </div>
          <t-empty v-else-if="currentItem.state === '生成失败'" type="fail" :title="$t('workbench.cornerScape.genFailed')" />
          <t-image v-else-if="currentItem.filePath" class="image" :src="currentItem.filePath" fit="contain">
            <template #error>
              <t-empty type="fail" :title="$t('workbench.cornerScape.imageError')" />
            </template>
            <template #overlayContent>
              <div class="imageToolsWrap show">
                <ImageTools :src="currentItem.filePath!" position="br" />
              </div>
            </template>
          </t-image>
          <t-empty v-else type="maintenance" :title="$t('workbench.cornerScape.noImage')" />
          <label class="replaceImageAction">
            替换图片
            <input data-action="replace-asset-image" type="file" accept=".png,.jpg,.jpeg,.webp" :disabled="assetWriteDisabled || replacing" @change="onReplaceImage" />
          </label>
        </div>
        <t-form v-if="currentItem" labelAlign="top">
          <t-form-item :label="$t('workbench.cornerScape.history')" data-section="asset-history">
            <div class="historyImageList f">
              <div
                v-for="item in currentItem.historyImages"
                :key="item.id"
                class="historyImageItem"
                :class="{ selected: selectedHistoryId === item.id }"
                @click.stop="!assetWriteDisabled && toggleHistorySelect(item.id)">
                <t-image :src="item.filePath" :style="{ width: '100px', minWidth: '100px', height: '100px' }" :lazy="true" fit="contain" />
              </div>
            </div>
          </t-form-item>
          <t-form-item v-if="currentItem.type === 'role'" :label="$t('workbench.cornerScape.assetsAudioLabel')" data-field="asset-audio">
            <div class="audioList audioList--detail" v-if="editForm.relepedAudio.length">
              <div v-for="audio in editForm.relepedAudio" :key="audio.id" class="audioList__item audioToolbar" data-role-audio-row>
                <span class="audioToolbar__name" data-field="audio-file-name">音色文件 {{ audio.name }}</span>
                <audio
                  v-if="audio.src"
                  :src="audio.src"
                  controls
                  preload="metadata"
                  data-role-audio-player
                  data-action="preview-role-audio"
                  :data-audio-id="audio.id"
                  @play="onRoleAudioPlay"
                  @ended="onRoleAudioEnded"
                />
                <p v-else class="audioUnplayable" data-feedback="audio-unplayable">音频文件不可播放</p>
                <a
                  v-if="audio.src"
                  :href="audio.src"
                  download
                  data-action="download-role-audio"
                  :data-audio-id="audio.id"
                >下载</a>
                <label class="audioReplace">
                  替换
                  <input data-action="replace-role-audio" type="file" accept=".mp3,.wav,.m4a,.aac,.ogg" :disabled="assetWriteDisabled" @change="onUploadAudio" />
                </label>
                <t-button type="button" size="small" variant="outline" data-action="select-role-audio" :disabled="assetWriteDisabled" @click="selectAudio">选择音频</t-button>
                <button type="button" class="audioRemove" data-action="remove-role-audio" :disabled="assetWriteDisabled" @click="removeAudio(audio.id)">移除</button>
              </div>
            </div>
            <div v-else class="audioToolbar" data-role-audio-row>
              <div class="assets-empty" data-empty="no-role-audio">暂无音色</div>
              <label class="audioReplace">
                替换
                <input data-action="replace-role-audio" type="file" accept=".mp3,.wav,.m4a,.aac,.ogg" :disabled="assetWriteDisabled" @change="onUploadAudio" />
              </label>
              <t-button type="button" size="small" variant="outline" data-action="select-role-audio" :disabled="assetWriteDisabled" @click="selectAudio">选择音频</t-button>
            </div>
            <p v-if="audioPreviewError" class="assets-empty" data-feedback="audio-preview-error">{{ audioPreviewError }}</p>
          </t-form-item>
          <div class="assetFieldRow" data-row="asset-identity">
            <t-form-item label="资产/文件名">
              <t-input v-model="editForm.name" data-field="asset-name" :disabled="assetWriteDisabled" />
            </t-form-item>
            <t-form-item label="别名">
              <t-input v-model="editForm.remark" data-field="asset-alias" :disabled="assetWriteDisabled" />
            </t-form-item>
          </div>
          <t-form-item label="详细描述">
            <t-textarea v-model="editForm.describe" data-field="asset-describe" :disabled="assetWriteDisabled" />
          </t-form-item>
          <t-form-item :label="$t('workbench.cornerScape.promptLabel')">
            <t-loading style="width: 100%" :loading="currentItem.promptState == '生成中'">
              <t-textarea
                v-model="editForm.prompt"
                data-field="asset-prompt"
                :placeholder="$t('workbench.cornerScape.promptPh')"
                :autosize="{ minRows: 4, maxRows: 10 }"
                :disabled="assetWriteDisabled || polishing"
                @blur="savePromptOnBlur" />
            </t-loading>
          </t-form-item>
          <t-form-item :label="$t('workbench.cornerScape.genModel')">
            <div data-field="asset-model" :class="{ 'is-readonly': assetWriteDisabled }">
              <modelSelect v-model="editForm.model" :type="`image`" />
            </div>
          </t-form-item>
          <div class="assetFieldRow" data-row="asset-spec">
            <t-form-item label="图片尺寸 / 画幅">
              <div data-field="asset-ratio" class="ratioSwitch">
                <label><input v-model="editForm.imageRatio" type="radio" value="16:9" :disabled="assetWriteDisabled" />16:9</label>
                <label><input v-model="editForm.imageRatio" type="radio" value="9:16" :disabled="assetWriteDisabled" />9:16</label>
              </div>
            </t-form-item>
            <t-form-item :label="$t('workbench.cornerScape.resolution')">
              <t-select v-model="editForm.resolution" data-field="asset-resolution" :placeholder="$t('workbench.cornerScape.resolutionPh')" :options="resolutionOptions" :disabled="assetWriteDisabled" />
            </t-form-item>
          </div>
          <t-form-item>
            <div class="drawerActions">
              <t-button theme="default" variant="outline" data-action="save-asset-info" :loading="saving" :disabled="assetWriteDisabled" @click="handleSaveAssetInfo">
                保存信息
              </t-button>
              <t-button
                theme="default"
                variant="outline"
                :loading="polishing"
                @click="polishPrompts"
                :disabled="assetWriteDisabled || currentItem.promptState == '生成中'">
                <template #icon><t-icon name="edit" /></template>
                {{ $t("workbench.cornerScape.aiPolish") }}
              </t-button>
              <t-button theme="primary" @click="regenerateItem" :disabled="assetWriteDisabled || currentItem.state == '生成中'">
                <template #icon><t-icon name="refresh" /></template>
                {{ $t("workbench.cornerScape.regenerate") }}
              </t-button>
            </div>
          </t-form-item>
        </t-form>
      </t-drawer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onUnmounted, watch } from "vue";
import modelSelect from "@/components/modelSelect.vue";
import projectStore from "@/stores/project";
import { cornerScapeContextKey } from "../composables/cornerScapeContext";
import { useRoleAudioPreview } from "../composables/useRoleAudioPreview";
import CornerScapeAssetActions from "./CornerScapeAssetActions.vue";

const emit = defineEmits<{ changed: [] }>();
const store = projectStore();
const assetWriteDisabled = computed(() => (
  !store.canWrite
  || store.project?.myRole === "viewer"
  || store.project?.openMode === "readonly"
));

const {
  dataList, getFilteredData, selectAll, selectPromptEmpty, selectByState, toggleSelectAll, clearSelection,
  previewImages, hasPreviewImages, onChangeFn, checkboxValue, translatedOptions,
  selectValue, resolution, otherTextPrompt, selectedIds, batchGenerationPrompt,
  batchSelectBindAudio, batchGenerationImage, openDrawer, toggleSelect,
  cancelGenerationFn, drawerVisible, currentItem, editForm, selectedHistoryId,
  toggleHistorySelect, resolutionOptions, polishing, saving, replacing, savePromptOnBlur,
  selectAudio, removeAudio, polishPrompts, regenerateItem,
  saveAssetInfo, replaceAssetImage, uploadRoleAudio, revokeLocalPreview,
} = inject(cornerScapeContextKey)!;

const { errorMessage: audioPreviewError, stop: stopAudioPreview, toggle: previewAudio } = useRoleAudioPreview();

function stopNativeAudioPlayers(): void {
  document.querySelectorAll<HTMLAudioElement>("[data-role-audio-player]").forEach((element) => {
    try {
      element.pause();
      element.currentTime = 0;
    } catch {
      // jsdom 没有实现 HTMLMediaElement.pause。
    }
  });
}

function onRoleAudioPlay(event: Event): void {
  const current = event.currentTarget as HTMLAudioElement;
  // 中文注释：原生播放器逐条互斥，开始一条必须停掉其余，避免叠音。
  stopAudioPreview();
  document.querySelectorAll<HTMLAudioElement>("[data-role-audio-player]").forEach((element) => {
    if (element === current) return;
    try {
      element.pause();
    } catch {
      // jsdom 没有实现 HTMLMediaElement.pause。
    }
  });
}

function onRoleAudioEnded(event: Event): void {
  const element = event.currentTarget as HTMLAudioElement;
  try {
    element.currentTime = 0;
  } catch {
    // jsdom 可能拒绝写入 currentTime。
  }
}

watch(drawerVisible, (open) => {
  if (!open) {
    stopAudioPreview();
    stopNativeAudioPlayers();
    revokeLocalPreview();
  }
});
watch(() => currentItem.value?.id, () => {
  stopAudioPreview();
  stopNativeAudioPlayers();
  revokeLocalPreview();
});
watch(() => editForm.relepedAudio.map((item) => String(item.src ?? "")).join("\0"), () => {
  // 中文注释：切换 blob / 受保护 URL 前先停掉旧播放器，避免旧 src 继续占着控件。
  stopNativeAudioPlayers();
});
onUnmounted(() => {
  stopAudioPreview();
  stopNativeAudioPlayers();
  revokeLocalPreview();
});

function onReplaceImage(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) void replaceAssetImage(file).then(() => emit("changed"));
}

function onUploadAudio(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) void uploadRoleAudio(file).then(() => emit("changed"));
}

async function handleSaveAssetInfo(): Promise<void> {
  const saved = await saveAssetInfo();
  if (saved) emit("changed");
}

function handleLocalAssetsChanged(): void {
  void getFilteredData();
  emit("changed");
}
</script>

<style lang="scss" scoped>
@use "../styles/corner-scape-workspace.scss";

.is-readonly {
  pointer-events: none;
  opacity: 0.62;
}

.ratioSwitch {
  display: flex;
  gap: 12px;
}

.replaceImageAction {
  display: grid;
  gap: 6px;
  margin-top: 10px;
}
</style>

<template>
  <div class="imageUploadBox ac">
    <!-- 单图模式 -->
    <template v-if="mode == 'singleImage' || Array.isArray(parseMode(mode as string))">
      <div class="uploadBtn c fc module-interactive--sm" v-for="(item, index) in mode == 'singleImage' ? imageList.slice(0, 1) : imageList" :key="index">
        <template v-if="item.src">
          <t-image v-if="item.fileType == 'image'" :src="item.src" fit="contain" class="uploadPreview">
            <template #overlayContent>
              <div class="imageToolsWrap">
                <ImageTools :src="item.src!" position="br" />
              </div>
            </template>
          </t-image>
          <t-tooltip theme="primary" v-else-if="item.fileType == 'audio'" :content="item?.prompt || ''">
            <div class="mediaPreview audioPreview">
              <i-acoustic size="20" />
              <span class="mediaLabel">音频</span>
            </div>
          </t-tooltip>
          <div v-else-if="item.fileType == 'video'" class="mediaPreview videoPreview">
            <video class="uploadPreview" :src="item.src" preload="metadata" muted />
          </div>
        </template>
        <template v-else>
          <t-tooltip theme="primary" :content="item?.prompt ? '音频内容：' + item.prompt : ''">
            <span style="font-size: 20px">文</span>
          </t-tooltip>
        </template>
        <div class="imageTitleWrap" v-if="item.sources == 'storyboard' && item.index != null">
          {{ `P${item.index + 1}` }}
        </div>
        <div class="clearBtn" @click="splitImage(index)">
          <i-close size="12" />
        </div>
        <div class="source">
          <t-tag size="small">
            {{ item.sources == "storyboard" ? $t("workbench.generate.storyboard") : $t("workbench.generate.assets") }}
          </t-tag>
        </div>
      </div>
    </template>
    <template v-else-if="mode == 'endFrameOptional' || mode == 'startFrameOptional' || mode == 'startEndRequired'">
      <div class="uploadBtn c fc module-interactive--sm" v-for="(item, index) in buildLabel" :key="item.value" @click="handleMixedAdd(item.value as 'start' | 'end')" tabindex="0">
        <div v-if="!isEmptySlot(imageList?.[index])" style="flex: 1; width: 100%" class="ac">
          <template v-if="imageList?.[index]?.src">
            <t-image v-if="imageList?.[index]?.fileType == 'image'" :src="imageList?.[index]!.src" fit="contain" class="uploadPreview">
              <template #overlayContent>
                <div class="imageToolsWrap">
                  <ImageTools :src="imageList?.[index]!.src" position="br" />
                </div>
              </template>
            </t-image>
            <div v-else-if="imageList?.[index]?.fileType == 'audio'" class="mediaPreview audioPreview">
              <i-acoustic size="20" />
              <span class="mediaLabel">音频</span>
            </div>
            <div v-else-if="imageList?.[index]?.fileType == 'video'" class="mediaPreview videoPreview">
              <video class="uploadPreview" :src="imageList?.[index]!.src" preload="metadata" muted />
            </div>
          </template>
          <template v-else>
            <t-tooltip theme="primary" :content="imageList?.[index]?.prompt || ''">
              <span style="font-size: 20px">文</span>
            </t-tooltip>
          </template>
          <div class="imageTitleWrap" v-if="imageList?.[index]?.sources == 'storyboard' && imageList?.[index]?.index != null">
            {{ `P${imageList[index]?.index + 1}` }}
          </div>
          <div class="clearBtn" @click.stop="clearImage(index)">
            <i-close size="12" />
          </div>
          <div class="source">
            <t-tag size="small">
              {{ imageList?.[index]?.sources == "storyboard" ? $t("workbench.generate.storyboard") : $t("workbench.generate.assets") }}
            </t-tag>
          </div>
        </div>
        <template v-else>
          <i-plus size="24"></i-plus>
          {{ item.label }}
        </template>
      </div>
    </template>
    <div class="uploadBtn c fc" v-if="isShowAddImage" @click="handleMixedAdd()">
      <i-plus size="24"></i-plus>
      {{ $t("workbench.generate.addReference") }}
    </div>

    <!-- 分镜选择弹窗 -->
    <t-dialog
      v-model:visible="storyboardDialogVisible"
      :header="$t('workbench.generate.selectStoryboard')"
      :footer="false"
      width="800px"
      placement="center">
      <div class="storyboardGrid">
        <div class="storyboardItem" v-for="sb in storyboardList" :key="sb.id" @click="pickStoryboard(sb)">
          <div class="imageTitleWrap" v-if="sb?.index != null">
            {{ `P${sb?.index + 1}` }}
          </div>
          <img v-if="sb.src" :src="sb.src" />
          <div v-else class="textBox ac jc">
            <t-tooltip theme="primary" :content="sb?.videoDesc || ''">
              <span style="font-size: 20px">{{ `分镜 ${sb?.index + 1 || ""}` }}</span>
            </t-tooltip>
          </div>
        </div>
      </div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import "@/views/production/components/workbench/type/type";
import assetsCheck, { type AssetType, type ClipMediaType } from "@/utils/assetsCheck";
import axios from "@/utils/axios";

const props = defineProps<{
  mode: VideoMode;
  storyboardList: StoryboardItem[];
}>();
const imageList = defineModel<UploadItem[]>({
  default: () => [],
});
//分镜选择弹窗
const storyboardDialogVisible = ref(false);

/** 空占位项，用于首尾帧模式中未设置的槽位 */
const EMPTY_SLOT: UploadItem = { fileType: "image", id: null, src: "" } as any;
function isEmptySlot(item: UploadItem | undefined): boolean {
  return !item || !item.id;
}

const buildLabel = computed(() => {
  const startOptional = props.mode === "startFrameOptional";
  const endOptional = props.mode === "endFrameOptional";
  return [
    { label: startOptional ? "首帧(可选)" : "首帧", value: "start" },
    { label: endOptional ? "尾帧(可选)" : "尾帧", value: "end" },
  ];
});

/** 确保 imageList 始终有两个槽位（首帧 index=0，尾帧 index=1） */
function ensureFrameSlots(): UploadItem[] {
  const list = [...imageList.value];
  while (list.length < 2) list.push({ ...EMPTY_SLOT });
  return list;
}

/** 将 item 设置到首帧或尾帧槽位 */
function setFrameSlot(slot: "start" | "end", item: UploadItem) {
  const list = ensureFrameSlots();
  list[slot === "start" ? 0 : 1] = item;
  imageList.value = list;
}

/** 解析模式值（字符串或 JSON 数组） */
function parseMode(value: string): VideoMode | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed as ReferenceType[];
  } catch {
    return value as Exclude<VideoMode, ReferenceType[]>;
  }
  return value as Exclude<VideoMode, ReferenceType[]>;
}

//判断是否显示添加参考图
const isShowAddImage = computed(() => {
  const mode = props.mode;
  if (mode == "singleImage" && imageList.value.length >= 1) {
    return false;
  }
  if (mode == "endFrameOptional" || mode == "startEndRequired" || mode == "startFrameOptional") {
    return false;
  }
  if (mode == "text") return false;
  //多参模式默认 true
  return true;
});

/** 根据文件扩展名推断媒体类型 */
function getFileTypeByExt(src: string | undefined): "image" | "video" | "audio" {
  const ext = src?.split(".").pop()?.toLowerCase() ?? "";
  if (["mp4", "webm", "mov", "avi", "mkv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "aac", "flac", "m4a"].includes(ext)) return "audio";
  return "image";
}
/** 根据混合模式推导当前允许的 clip 媒体类型 */
const mixedClipMediaTypes = computed<ClipMediaType[]>(() => {
  const mode = props.mode;
  if (!Array.isArray(mode)) return [];
  const map: Record<string, ClipMediaType> = { audioReference: "audio", imageReference: "image", videoReference: "video" };
  return mode.filter((m) => m in map).map((m) => map[m]);
});
let currentSlot: "start" | "end" | "" = "";
function handleMixedAdd(slot: "start" | "end" | "" = "") {
  if (!props.mode) return window.$message.error($t("workbench.generate.notSelectMode"));
  currentSlot = slot;
  const multiple = Array.isArray(parseMode(props.mode as string));
  const dlg = DialogPlugin.confirm({
    header: $t("workbench.generate.selectSource"),
    confirmBtn: $t("workbench.generate.confirm"),
    cancelBtn: $t("workbench.generate.cancel"),
    onConfirm: async () => {
      dlg.destroy();
      const assets = await assetsCheck({ types: ["role", "tool", "scene", "clip", "audio"], clipMediaTypes: mixedClipMediaTypes.value, multiple });

      if (!assets.length) return;

      const newItems: UploadItem[] = assets.flatMap((asset) => {
        if (asset.type === "audio" && asset?.sonAssets?.length) {
          return asset.sonAssets.map((sub: any) => {
            const fileType = getFileTypeByExt(sub.src);
            return {
              fileType,
              sources: "assets",
              src: sub.src,
              id: sub.id,
              prompt: sub.prompt,
            } as UploadItem;
          });
        }
        const fileType = getFileTypeByExt(asset.src);
        return [
          {
            fileType,
            sources: "assets",
            src: asset.src,
            id: asset.id,
            prompt: asset.prompt,
          } as UploadItem,
        ];
      });
      if (slot === "start" || slot === "end") {
        setFrameSlot(slot, newItems[0]);
      } else if (props.mode === "singleImage") {
        imageList.value = [newItems[0]];
      } else {
        const assetsNotAudioIds = newItems.filter((i) => i.fileType !== "audio");
        const { data } = await axios.post("/production/workbench/getAudioBindAssetsList", {
          assetsIds: assetsNotAudioIds.map((i) => i.id),
        });
        imageList.value = [...imageList.value, ...newItems, ...(data ?? [])];
      }
    },
    onCancel: () => {
      dlg.destroy();
      storyboardDialogVisible.value = true;
    },
  });
}
function clearImage(index: number) {
  const list = ensureFrameSlots();
  list[index] = { ...EMPTY_SLOT };
  imageList.value = list;
}
/** 分镜弹窗选中回调 */
function pickStoryboard(sb: StoryboardItem) {
  storyboardDialogVisible.value = false;
  const fileType = "image";
  const newItem = {
    fileType,
    sources: "storyboard",
    src: sb.src,
    id: sb.id,
    prompt: sb.videoDesc ?? undefined,
    index: sb.index,
  } as UploadItem;

  if (currentSlot === "start" || currentSlot === "end") {
    setFrameSlot(currentSlot, newItem);
  } else {
    imageList.value = [...imageList.value, newItem];
  }
}
function splitImage(index: number) {
  const list = [...imageList.value];
  list.splice(index, 1);
  imageList.value = list;
}
</script>

<style lang="scss" scoped>
@use './styles/image-select.scss';
</style>

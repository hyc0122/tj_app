/**
 * 内置供应商按 provider + mediaType 的参考素材合同。
 * 依据 app/data/vendor 适配器最终请求字段逐个核对，禁止供应商级 URL/内联布尔值，
 * 也禁止把未写入请求字段的音频/视频静默丢掉。
 *
 * atlascloud：images / reference_images / reference_videos / reference_audios，短签 URL。
 * grsai：仅 firstFrameUrl / lastFrameUrl / urls，没有音频或视频文件字段。
 * klingai：image_url / image_list 内联；sound 只是布尔，不消费音频文件；videoRefs 未写入请求。
 * tianjiang：ReferenceItem.sourceType=base64，image/video/audio 均消费内联内容。
 * vidu：只消费 imageBase64；metadata.audio 只是布尔。
 * volcengine：image_url / video_url / audio_url。
 * volcengineSd2：parseBase64 后 uploadAssets，image/video/audio 均为内联。
 * minimax：仅 first_frame_image / last_frame_image 内联。
 * openai / deepseek / null：视频路径未声明参考素材合同。
 */
export type VendorMediaForm = "url" | "inline" | "none";
export type VendorMediaKind = "image" | "audio" | "video";

export interface VendorMediaTypeCapability {
  form: VendorMediaForm;
}

const BUILTIN_MEDIA_FORM: Record<string, Record<VendorMediaKind, VendorMediaForm>> = {
  atlascloud: { image: "url", audio: "url", video: "url" },
  grsai: { image: "url", audio: "none", video: "none" },
  klingai: { image: "inline", audio: "none", video: "none" },
  tianjiang: { image: "inline", audio: "inline", video: "inline" },
  vidu: { image: "inline", audio: "none", video: "none" },
  volcengine: { image: "url", audio: "url", video: "url" },
  volcengineSd2: { image: "inline", audio: "inline", video: "inline" },
  minimax: { image: "inline", audio: "none", video: "none" },
  openai: { image: "none", audio: "none", video: "none" },
  deepseek: { image: "none", audio: "none", video: "none" },
  null: { image: "none", audio: "none", video: "none" },
};

function declaredForm(
  vendorMetadata: Record<string, unknown> | undefined,
  mediaType: VendorMediaKind,
): VendorMediaForm | undefined {
  const caps = vendorMetadata?.mediaCapabilities;
  if (!caps || typeof caps !== "object") return undefined;
  const value = (caps as Record<string, unknown>)[mediaType];
  if (value === "url" || value === "inline" || value === "none") return value;
  return undefined;
}

export function resolveVendorMediaCapability(
  provider: string,
  mediaType: VendorMediaKind,
  vendorMetadata?: Record<string, unknown>,
): VendorMediaTypeCapability {
  const id = String(provider ?? "").trim();
  const builtin = BUILTIN_MEDIA_FORM[id]?.[mediaType];
  if (builtin) return { form: builtin };
  // 中文注释：未知供应商只认显式 mediaCapabilities[type]，禁止回退供应商级布尔猜测。
  return { form: declaredForm(vendorMetadata, mediaType) ?? "none" };
}

export function builtinVendorMediaCapabilityMatrix(): Readonly<
  Record<string, Record<VendorMediaKind, VendorMediaForm>>
> {
  return BUILTIN_MEDIA_FORM;
}

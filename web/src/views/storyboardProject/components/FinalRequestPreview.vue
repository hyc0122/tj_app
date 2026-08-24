<template>
  <section class="requestPreview" data-panel="request-preview">
    <header><div><span>REQUEST PREVIEW</span><strong>最终请求预览</strong></div><t-icon name="code" /></header>
    <div class="requestPreview__model"><span>模型路由</span><strong>{{ request?.providerModel || "等待服务端预览" }}</strong></div>
    <div class="requestPreview__prompt"><span>合成提示词</span><p>{{ request?.prompt || "请先请求非收费的最终生成预览" }}</p></div>
    <div v-if="request?.referenceSummary" class="requestPreview__refs" data-field="reference-summary">
      <span>引用摘要</span>
      <p>图片 {{ request.referenceSummary.image.count }}：{{ request.referenceSummary.image.labels.join("、") || "无" }}</p>
      <p>视频 {{ request.referenceSummary.video.count }}：{{ request.referenceSummary.video.labels.join("、") || "无" }}</p>
      <p>音频 {{ request.referenceSummary.audio.count }}：{{ request.referenceSummary.audio.labels.join("、") || "无" }}</p>
    </div>
    <dl>
      <template v-for="(value, key) in request?.options || {}" :key="key">
        <dt>{{ optionLabel(String(key)) }}</dt><dd>{{ value }}</dd>
      </template>
    </dl>
    <small>此处仅展示服务端返回的白名单字段，不包含账号凭据、Cookie 或令牌。</small>
  </section>
</template>

<script setup lang="ts">
const props = defineProps<{
  request?: {
    providerModel: string;
    prompt: string;
    options?: Record<string, string | number | boolean>;
    referenceSummary?: {
      image: { count: number; labels: string[] };
      video: { count: number; labels: string[] };
      audio: { count: number; labels: string[] };
    };
  } | null;
}>();

function optionLabel(key: string): string {
  return ({ aspectRatio: "画幅", durationMs: "时长（毫秒）", resolution: "分辨率", mode: "生成模式" } as Record<string, string>)[key] || key;
}
</script>

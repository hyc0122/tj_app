<template>
  <t-dialog
    :visible="visible"
    width="620px"
    :footer="false"
    class="dreaminaAuthDialog"
    @close="emit('update:visible', false)"
  >
    <div class="authDialogBody">
      <div class="authDialogHero">
        <span class="authDialogHero__icon"><t-icon name="secured" /></span>
        <div>
          <span>OFFICIAL DEVICE AUTHORIZATION</span>
          <h3>登录即梦 CLI</h3>
          <p>授权只在当前设备完成，天将漫创不会读取你的密码。</p>
        </div>
      </div>

      <div class="authStep">
        <span class="authStep__number">1</span>
        <div>
          <strong>在默认浏览器打开官方授权页</strong>
          <div class="copyField">
            <code>{{ verificationUri || "授权地址不可用" }}</code>
            <t-button size="small" variant="text" data-action="auth-dialog-copy-url" :disabled="!verificationUri" @click="emit('copy-url')">复制</t-button>
          </div>
          <t-button block theme="primary" data-action="auth-dialog-open-browser" :disabled="!verificationUri" @click="emit('open-browser')">
            <template #icon><t-icon name="browse" /></template>
            在本机浏览器打开授权页
          </t-button>
        </div>
      </div>

      <div class="authStep">
        <span class="authStep__number">2</span>
        <div>
          <strong>输入本次设备用户码</strong>
          <div class="authCode">
            <span>{{ userCode || "— — — —" }}</span>
            <t-button variant="outline" data-action="auth-dialog-copy-code" :disabled="!userCode" @click="emit('copy-code')">复制用户码</t-button>
          </div>
        </div>
      </div>

      <div class="authDialogFooter">
        <div class="authCountdown">
          <t-icon name="time" />
          <span v-if="remainingSeconds > 0">授权信息将在 {{ remainingLabel }} 后过期</span>
          <span v-else>授权信息已过期，请关闭后重新发起</span>
        </div>
        <div class="authDialogFooter__actions">
          <t-button variant="outline" @click="emit('update:visible', false)">稍后处理</t-button>
          <t-button
            theme="primary"
            data-action="check-authorization"
            :loading="checking"
            :disabled="!userCode || remainingSeconds <= 0"
            @click="emit('check')"
          >
            我已完成授权，检查状态
          </t-button>
        </div>
      </div>
    </div>
  </t-dialog>
</template>

<script setup lang="ts">
const props = defineProps<{
  visible: boolean;
  verificationUri: string;
  userCode: string;
  expiresAt: number;
  checking?: boolean;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
  "copy-url": [];
  "copy-code": [];
  "open-browser": [];
  check: [];
}>();

const now = ref(Date.now());
let ticker: number | undefined;

const remainingSeconds = computed(() => Math.max(0, Math.ceil((props.expiresAt - now.value) / 1000)));
const remainingLabel = computed(() => {
  const minutes = Math.floor(remainingSeconds.value / 60);
  const seconds = remainingSeconds.value % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
});

function stopTicker() {
  if (ticker !== undefined) window.clearInterval(ticker);
  ticker = undefined;
}

watch(() => props.visible, (visible) => {
  stopTicker();
  now.value = Date.now();
  if (visible) ticker = window.setInterval(() => { now.value = Date.now(); }, 1000);
}, { immediate: true });

onBeforeUnmount(stopTicker);
</script>

<template>
  <t-dialog v-model:visible="show" :footer="false" :header="false" width="680px" :close-on-overlay-click="false" placement="center">
    <div class="helloGuide">
      <!-- 欢迎首页 -->
      <template v-if="currentStep === 0">
        <div class="welcomePage">
          <img src="@/assets/logo.png" alt="天将漫创 Logo" class="welcomeLogo" />
          <h1 class="welcomeTitle">{{ $t("hello.welcomeTitle") }}</h1>
          <p class="welcomeDesc">{{ $t("hello.welcomeDesc") }}</p>
          <t-button theme="primary" size="large" @click="currentStep = 1">{{ $t("hello.startConfig") }}</t-button>
          <t-button variant="text" size="small" style="margin-top: 12px" :disabled="saving" @click="handleSkip">{{ $t("hello.skip") }}</t-button>
          <div class="langBtn">
            <t-dropdown :options="langOptions" trigger="click" @click="handleChangeLang" :maxColumnWidth="150">
              <t-button shape="circle" theme="default" size="large">
                <template #icon>
                  <i-translate theme="outline" size="20" />
                </template>
              </t-button>
            </t-dropdown>
          </div>
        </div>
      </template>

      <!-- 配置步骤 -->
      <template v-else>
        <t-steps :current="currentStep - 1" class="guideSteps">
          <t-step-item :title="$t('hello.configModel')" />
          <t-step-item :title="$t('hello.configData')" />
          <t-step-item :title="$t('hello.startUse')" />
        </t-steps>

        <div class="stepContent">
          <!-- Step 1: 配置模型服务 -->
          <div v-if="currentStep === 1" class="stepItem">
            <div class="stepIcon">
              <t-icon name="server" size="48px" />
            </div>
            <h2 class="stepTitle">{{ $t("hello.configModelTitle") }}</h2>
            <p class="stepDesc">{{ $t("hello.configModelDesc") }}</p>
            <div class="stepTip">
              <t-alert theme="info" :message="$t('hello.configModelTip')" />
            </div>
            <t-button theme="primary" size="large" @click="openVendorConfig">
              <template #icon><t-icon name="setting" /></template>
              {{ $t("hello.configModelBtn") }}
            </t-button>
          </div>

          <!-- Step 2: 配置 Agent -->
          <div v-if="currentStep === 2" class="stepItem">
            <div class="stepIcon">
              <t-icon name="relativity" size="48px" />
            </div>
            <h2 class="stepTitle">{{ $t("hello.configAgentTitle") }}</h2>
            <p class="stepDesc">{{ $t("hello.configAgentDesc") }}</p>
            <div class="stepTip">
              <t-alert theme="info" :message="$t('hello.configAgentTip')" />
            </div>
            <t-button theme="primary" size="large" @click="openAgentConfig">
              <template #icon><t-icon name="setting" /></template>
              {{ $t("hello.configAgentBtn") }}
            </t-button>
          </div>

          <!-- Step 3: 完成 -->
          <div v-if="currentStep === 3" class="stepItem">
            <div class="stepIcon">
              <t-icon name="check-circle" size="48px" color="var(--td-success-color)" />
            </div>
            <h2 class="stepTitle">{{ $t("hello.finishTitle") }}</h2>
            <p class="stepDesc">{{ $t("hello.finishDesc") }}</p>
            <div v-if="supportQrCodeUrl" class="qrcodeBox">
              <p class="qrcodeLabel">{{ $t("hello.qrcodeLabel") }}</p>
              <!-- 后台下发的是已生成的二维码图片，必须直接展示，不能再编码图片 URL。 -->
              <img
                :src="supportQrCodeUrl"
                alt="客服支持二维码"
                class="supportQrCodeImage"
              />
            </div>
          </div>
        </div>
        <!-- 底部按钮 -->
        <div class="guideFooter">
          <t-button v-if="currentStep > 1" variant="outline" @click="currentStep--">{{ $t("hello.prevStep") }}</t-button>
          <div class="footerRight">
            <t-button v-if="currentStep < 3" variant="text" :disabled="saving" @click="handleSkip">{{ $t("hello.skip") }}</t-button>
            <t-button v-if="currentStep < 3" theme="primary" @click="currentStep++">{{ $t("hello.nextStep") }}</t-button>
            <t-button v-if="currentStep === 3" theme="primary" :loading="saving" @click="handleFinish">{{ $t("hello.finish") }}</t-button>
          </div>
        </div>
      </template>
      <t-alert
        v-if="saveError"
        class="save-error"
        theme="error"
        :message="saveError"
      />
    </div>
  </t-dialog>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import JSConfetti from "js-confetti";
import axios from "@/utils/axios";
import settingStore from "@/stores/setting";
import { languageList, cachedLocale } from "@/locales";
const { showSetting, activeMenu } = storeToRefs(settingStore());

const { locale } = useI18n();
const langOptions = languageList.map((item) => ({
  content: item.label,
  value: item.value,
}));
const handleChangeLang = (data: any) => {
  locale.value = data.value;
  cachedLocale.value = data.value;
};

// 引导完成写入 Electron 稳定存储（账号+设备隔离），禁止 localStorage。
const completedRevision = ref(0);
const guideRevision = ref(1);
const show = ref(false);
const currentStep = ref(0);
const supportQrCodeUrl = ref("");
const saving = ref(false);
const saveError = ref("");
const shouldShow = computed(() => completedRevision.value < guideRevision.value);

async function loadOnboardingState() {
  try {
    const configRes = await axios.get("/tianjiang/public/client-config");
    const config = configRes?.data?.config ?? configRes?.config;
    if (config?.onboarding?.guideRevision != null) {
      guideRevision.value = Number(config.onboarding.guideRevision) || 1;
    }
    supportQrCodeUrl.value = typeof config?.onboarding?.supportQrCodeUrl === "string"
      ? config.onboarding.supportQrCodeUrl
      : "";
  } catch {
    guideRevision.value = 1;
    supportQrCodeUrl.value = "";
  }
  try {
    const stateRes = await axios.get("/tianjiang/client-state/onboarding");
    const state = stateRes?.data ?? stateRes;
    completedRevision.value = Number(state?.completedRevision ?? 0) || 0;
  } catch {
    completedRevision.value = 0;
  }
  show.value = shouldShow.value;
}

async function finishGuide(): Promise<boolean> {
  if (saving.value) return false;
  saving.value = true;
  saveError.value = "";
  try {
    await axios.put("/tianjiang/client-state/onboarding", {
      completedRevision: guideRevision.value,
    });
    completedRevision.value = guideRevision.value;
    show.value = false;
    return true;
  } catch {
    // 保持引导可见并允许重试，避免把未持久化状态误当作完成。
    saveError.value = "引导完成状态保存失败，请重试。";
    return false;
  } finally {
    saving.value = false;
  }
}

function openVendorConfig() {
  activeMenu.value = "vendorConfig";
  showSetting.value = true;
}

function openAgentConfig() {
  activeMenu.value = "agentConfog";
  showSetting.value = true;
}

async function handleSkip() {
  await finishGuide();
}

async function handleFinish() {
  const saved = await finishGuide();
  if (!saved) return;
  const jsConfetti = new JSConfetti();
  jsConfetti.addConfetti();
}

onMounted(() => {
  void loadOnboardingState();
});

</script>

<style lang="scss" scoped>
.helloGuide {
  padding: 24px 16px;

  .welcomePage {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 40px 0 24px;
    position: relative;

    .langBtn {
      position: absolute;
      bottom: 0;
      right: 0;
    }

    .welcomeLogo {
      width: 120px;
      height: 120px;
      object-fit: contain;
      margin-bottom: 24px;
    }

    .welcomeTitle {
      font-size: 28px;
      font-weight: 700;
      margin: 0 0 12px;
    }

    .welcomeDesc {
      color: var(--td-text-color-secondary);
      font-size: 15px;
      margin: 0 0 32px;
    }
  }

  .guideSteps {
    margin-bottom: 32px;
  }

  .stepContent {
    min-height: 300px;
    display: flex;
    align-items: center;
    justify-content: center;

    .stepItem {
      text-align: center;
      max-width: 480px;

      .stepIcon {
        margin-bottom: 16px;
        color: var(--td-brand-color);
      }

      .stepTitle {
        font-size: 22px;
        font-weight: 600;
        margin: 0 0 12px;
      }

      .stepDesc {
        color: var(--td-text-color-secondary);
        font-size: 14px;
        line-height: 1.8;
        margin: 0 0 20px;
      }

      .stepTip {
        margin-bottom: 20px;
      }

      .qrcodeBox {
        margin-top: 16px;
        display: flex;
        flex-direction: column;
        align-items: center;

        .qrcodeLabel {
          color: var(--td-text-color-secondary);
          font-size: 13px;
          margin-bottom: 8px;
        }

        .supportQrCodeImage {
          width: 160px;
          height: 160px;
          object-fit: contain;
        }
      }

      .githubBox {
        margin-top: 20px;
        display: flex;
        flex-direction: column;
        align-items: center;
      }
    }
  }

  .guideFooter {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 24px;
    border-top: 1px solid var(--td-component-stroke);
    padding-top: 16px;

    .footerRight {
      display: flex;
      gap: 8px;
      margin-left: auto;
    }
  }
}
</style>

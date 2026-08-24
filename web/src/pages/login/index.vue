<template>
  <div
    class="loginPage"
    :style="{ height: isElectron ? 'calc(100vh - var(--app-titlebar-height))' : '100vh' }"
  >
    <AuthAnimatedBackdrop />
    <div class="formBox">
      <div class="logoBox fc">
        <img
          src="/src/assets/logo.png"
          :alt="`${BRAND.displayName} Logo`"
          class="logoImg"
        />
        <div class="fc c">
          <span class="logoText">{{ BRAND.displayName }}</span>
        </div>
      </div>
      <div class="login-form">
        <t-input
          v-model="form.username"
          :placeholder="$t('login.username')"
          autocomplete="username"
          size="large"
        />
        <t-input
          v-if="isRegister"
          v-model="form.nickname"
          :placeholder="$t('login.nickname')"
          autocomplete="nickname"
          size="large"
        />
        <t-input
          v-model="form.password"
          type="password"
          :placeholder="$t('login.password')"
          :autocomplete="isRegister ? 'new-password' : 'current-password'"
          size="large"
        />
        <!-- 注册页持续展示与后台一致的密码规则，并随输入逐项反馈。 -->
        <ul v-if="isRegister" class="password-rules" aria-live="polite">
          <li :class="{ ok: passwordPolicy.minLength }">至少 8 个字符</li>
          <li :class="{ ok: passwordPolicy.hasLetter && passwordPolicy.hasDigit }">
            必须同时包含字母和数字
          </li>
          <li :class="{ ok: passwordPolicy.withinByteLimit }">UTF-8 总长度不超过 72 字节</li>
        </ul>
        <t-input
          v-if="isRegister"
          v-model="form.confirmPassword"
          type="password"
          :placeholder="$t('login.confirmPassword')"
          autocomplete="new-password"
          size="large"
        />
        <p
          v-if="isRegister && form.confirmPassword && form.password !== form.confirmPassword"
          class="field-error"
          role="alert"
        >
          {{ $t("login.passwordMismatch") }}
        </p>
        <div v-if="captcha.openCaptcha" class="captcha-row">
          <t-input v-model="form.captcha" :placeholder="$t('login.captcha')" size="large" />
          <img
            :src="captcha.picPath"
            :alt="$t('login.captcha')"
            class="captcha-image"
            style="background-color: #fff"
            @click="loadCaptcha"
          />
        </div>
        <p
          v-if="captchaUnavailable"
          class="central-service-error"
          role="alert"
          aria-live="polite"
        >
          中央认证服务不可用，请检查网络连接或稍后重试。
        </p>
        <p
          v-if="offlineHint"
          class="central-service-error"
          role="status"
          aria-live="polite"
        >
          {{ offlineHint }}
        </p>
        <div
          v-if="stableGateMessage && !updateSnapshot.stableRequired"
          class="stable-update-warning"
          role="status"
          aria-live="polite"
        >
          <span>{{ stableGateMessage }}</span>
          <t-button
            variant="text"
            :loading="updateBusy"
            :disabled="updateBusy"
            @click="retryStableCheck"
          >
            重新检查正式版
          </t-button>
        </div>
        <t-button
          v-if="!isRegister"
          class="loginBtn"
          theme="primary"
          size="large"
          :loading="submitting"
          :disabled="authActionsDisabled"
          block
          @click="handleLogin"
        >
          {{ $t("login.login") }}
        </t-button>
        <t-button
          v-else
          class="loginBtn"
          theme="primary"
          size="large"
          :loading="submitting"
          :disabled="authActionsDisabled"
          block
          @click="handleRegister"
        >
          {{ $t("login.createAccount") }}
        </t-button>
        <t-button variant="text" :disabled="submitting" @click="switchMode">
          {{ isRegister ? $t("login.backToLogin") : $t("login.goToRegister") }}
        </t-button>
        <t-button
          v-if="!isRegister && hasSavedAccount"
          variant="text"
          theme="danger"
          :disabled="submitting"
          @click="handleClearSavedAccount"
        >
          {{ $t("login.clearSavedAccount") }}
        </t-button>
        <LegalConsentNotice
          :mode="isRegister ? 'register' : 'login'"
          @open="openDocument"
        />
      </div>
    </div>
  </div>
  <div class="settingBtn">
    <t-dropdown :options="langOptions" trigger="click" :maxColumnWidth="150" @click="handleChangeLang">
      <t-button shape="circle" theme="default" size="large">
        <template #icon>
          <i-translate theme="outline" size="20" />
        </template>
      </t-button>
    </t-dropdown>
  </div>
  <LegalDocumentDialog :document="activeDocument" @close="closeDocument" />
</template>

<script setup>
import { useI18n } from "vue-i18n";
import Router from "@/router/index";
import settingStore from "@/stores/setting";
import tianjiangUpdateStore from "@/stores/tianjiangUpdate";
import { storeToRefs } from "pinia";
import { languageList, cachedLocale } from "@/locales";
import { BRAND } from "@/brand.generated";
import {
  bootstrapAuth,
  centralLogin,
  centralRegister,
  clearSavedAccount,
  fetchCaptcha,
} from "@/features/tianjiang/auth/client";
import { evaluatePasswordPolicy } from "@/features/tianjiang/auth/password-policy";
import { navigateToProjectAfterAuth } from "@/features/tianjiang/auth/post-login-navigation";
import { useLegalDocuments } from "@/features/tianjiang/legal/use-legal-documents";
import AuthAnimatedBackdrop from "@/components/auth/AuthAnimatedBackdrop.vue";
import LegalConsentNotice from "@/components/legal/LegalConsentNotice.vue";
import LegalDocumentDialog from "@/components/legal/LegalDocumentDialog.vue";

const { locale, t } = useI18n();
const langOptions = languageList.map((item) => ({
  content: item.label,
  value: item.value,
}));
const handleChangeLang = (data) => {
  locale.value = data.value;
  cachedLocale.value = data.value;
};

const store = settingStore();
const { isElectron } = storeToRefs(store);
const desktopUpdateStore = tianjiangUpdateStore();
const {
  snapshot: updateSnapshot,
  busy: updateBusy,
  actionError: updateActionError,
} = storeToRefs(desktopUpdateStore);
const stableGateMessage = computed(() => {
  if (updateSnapshot.value.stableRequired) return "";
  if (!updateSnapshot.value.loginAllowed) {
    return updateActionError.value
      || updateSnapshot.value.errorMessage
      || "正式版更新检查未完成，请稍后重试";
  }
  return updateSnapshot.value.warningMessage ?? "";
});
const mode = ref("login");
const isRegister = computed(() => mode.value === "register");
const submitting = ref(false);
const captchaLoading = ref(true);
const captchaUnavailable = ref(false);
const offlineHint = ref("");
const hasSavedAccount = ref(false);
const authActionsDisabled = computed(
  () => submitting.value
    || captchaLoading.value
    || captchaUnavailable.value
    || updateSnapshot.value.stableRequired
    || (isElectron.value && !updateSnapshot.value.loginAllowed),
);
const form = ref({
  username: "",
  nickname: "",
  password: "",
  confirmPassword: "",
  captcha: "",
});
const captcha = ref({
  openCaptcha: false,
  captchaId: "",
  picPath: "",
});

const passwordPolicy = computed(() => evaluatePasswordPolicy(form.value.password));
const { activeDocument, openDocument, closeDocument } = useLegalDocuments();

const loadCaptcha = async () => {
  // 每次请求新验证码前先清空旧答案，避免新 captchaId 携带上一张图的输入。
  form.value.captcha = "";
  captchaLoading.value = true;
  try {
    const response = await fetchCaptcha();
    captcha.value = {
      openCaptcha: Boolean(response.data.openCaptcha),
      captchaId: response.data.captchaId ?? "",
      picPath: response.data.picPath ?? "",
    };
    captchaUnavailable.value = false;
  } catch {
    captcha.value = { openCaptcha: false, captchaId: "", picPath: "" };
    captchaUnavailable.value = true;
  } finally {
    captchaLoading.value = false;
  }
};

const clearPasswords = () => {
  // 仅在登录成功或切换到注册时清空；注册成功必须保留密码供回填。
  form.value.password = "";
  form.value.confirmPassword = "";
};

const validateCommonFields = () => {
  if (!form.value.username || !form.value.password) {
    window.$message.warning(t("login.enterUsernameAndPassword"));
    return false;
  }
  if (captcha.value.openCaptcha && !form.value.captcha) {
    window.$message.warning(t("login.captchaRequired"));
    return false;
  }
  return true;
};

const switchMode = async () => {
  mode.value = isRegister.value ? "login" : "register";
  clearPasswords();
  form.value.captcha = "";
  offlineHint.value = "";
  await loadCaptcha();
};

const announceKeyDegraded = (degraded) => {
  if (!degraded) return;
  // 非阻塞：登录已成功，个人配置同步暂不可用。
  const msg = t("login.keyServiceDegraded");
  if (typeof window.$message?.warning === "function") {
    window.$message.warning(msg);
  } else if (typeof window.$message?.info === "function") {
    window.$message.info(msg);
  }
};

const handleLogin = async () => {
  if (!validateCommonFields()) return;
  submitting.value = true;
  try {
    const gate = await checkStableBeforeAuth();
    // 中文注释：Stable 门禁由主进程快照裁定；renderer 不比较版本，也不能降级到 Beta 绕过。
    if (!gate.loginAllowed || gate.stableRequired) return;
    const result = await centralLogin({
      username: form.value.username,
      password: form.value.password,
      captcha: form.value.captcha,
      captchaId: captcha.value.captchaId,
    });
    // 必须 await 路由并确认已进入 /project；守卫若因会话失败退回登录，不得提示成功。
    const nav = await navigateToProjectAfterAuth(Router);
    if (!nav.ok) {
      window.$message.error(t("login.sessionNavigateFailed"));
      await loadCaptcha();
      return;
    }
    clearPasswords();
    await store.hydrateAccountAppearance();
    window.$message.success(t("login.loginSuccess"));
    announceKeyDegraded(result?.keyServiceDegraded);
  } catch (error) {
    // 全局拦截器对公开登录路径不弹“登录已过期”，此处只显示一条业务错误。
    window.$message.error(error?.message ?? t("login.centralLoginFailed"));
    await loadCaptcha();
  } finally {
    submitting.value = false;
  }
};

const handleRegister = async () => {
  if (!validateCommonFields()) return;
  if (!form.value.nickname) {
    window.$message.warning(t("login.nicknameRequired"));
    return;
  }
  if (!passwordPolicy.value.valid) {
    window.$message.warning(passwordPolicy.value.message ?? t("login.passwordPolicyInvalid"));
    return;
  }
  if (form.value.password !== form.value.confirmPassword) {
    window.$message.warning(t("login.passwordMismatch"));
    return;
  }
  submitting.value = true;
  try {
    await centralRegister({
      username: form.value.username,
      nickname: form.value.nickname,
      password: form.value.password,
      captcha: form.value.captcha,
      captchaId: captcha.value.captchaId,
    });
    window.$message.success(t("login.registerSuccess"));
    // 注册成功：回到登录、保留用户名与注册密码、刷新验证码，不建立会话。
    mode.value = "login";
    form.value.confirmPassword = "";
    form.value.captcha = "";
    await loadCaptcha();
  } catch (error) {
    window.$message.error(error?.message ?? t("login.registerFailed"));
    await loadCaptcha();
  } finally {
    submitting.value = false;
  }
};

const handleClearSavedAccount = async () => {
  try {
    await clearSavedAccount();
    form.value.username = "";
    clearPasswords();
    hasSavedAccount.value = false;
    offlineHint.value = "";
    window.$message.success(t("login.clearSavedAccountSuccess"));
  } catch (error) {
    window.$message.error(error?.message ?? t("login.clearSavedAccountFailed"));
  }
};

const runBootstrap = async () => {
  try {
    const gate = await checkStableBeforeAuth();
    if (!gate.loginAllowed || gate.stableRequired) return;
    const data = await bootstrapAuth();
    if (data.mode === "auto_login" || data.mode === "session") {
      // 自动登录同样必须真实进入 /project，失败只报错且保留已保存账号密码。
      const nav = await navigateToProjectAfterAuth(Router);
      if (!nav.ok) {
        window.$message.error(t("login.sessionNavigateFailed"));
        return;
      }
      await store.hydrateAccountAppearance();
      window.$message.success(t("login.loginSuccess"));
      announceKeyDegraded(data.keyServiceDegraded);
      return;
    }
    if (data.mode === "fill" || data.mode === "offline" || data.mode === "reauth_required") {
      if (data.username) form.value.username = data.username;
      if (data.password) form.value.password = data.password;
      hasSavedAccount.value = Boolean(data.username) && data.mode !== "reauth_required";
      if (data.mode === "offline") {
        offlineHint.value = data.message || t("login.offlineCredentialKept");
      }
      if (data.mode === "reauth_required") {
        // 允许手工登录；不得静默无提示
        offlineHint.value =
          data.message
          || "本地登录凭据无法解密，请重新输入账号密码登录以恢复同步。";
      }
    }
  } catch {
    // 引导失败不阻断手工登录。
  }
};

function checkStableBeforeAuth() {
  // 浏览器独立部署没有桌面安装器；Electron 登录与自动登录必须调用同一 Store 门禁。
  return isElectron.value
    ? desktopUpdateStore.checkLoginStable()
    : Promise.resolve(updateSnapshot.value);
}

async function retryStableCheck() {
  await desktopUpdateStore.checkLoginStable();
}

onMounted(() => {
  // 验证码与 Stable 门禁并行；自动登录引导必须在门禁返回后才提交保存凭据。
  void loadCaptcha();
  void runBootstrap();
});
</script>

<style lang="scss" scoped>
.loginPage {
  position: relative;
  height: 100vh;
  display: flex;
  justify-content: center;
  align-items: center;
  overflow: hidden;

  .formBox {
    position: relative;
    z-index: 1;
    width: 380px;
    padding: 40px 40px 30px;
    background: color-mix(in srgb, var(--td-bg-color-container) 92%, transparent);
    backdrop-filter: blur(8px);
    border-radius: 20px;
    box-shadow: var(--td-shadow-3);

    .logoBox {
      display: flex;
      justify-content: center;
      align-items: center;
      margin-bottom: 30px;
      gap: 12px;

      .logoImg {
        width: 64px;
        height: 64px;
        object-fit: contain;
      }

      .logoText {
        font-size: 36px;
        font-weight: 800;
        color: var(--td-text-color-primary);
        letter-spacing: 1px;
      }
    }

    .login-form {
      display: flex;
      flex-direction: column;
      gap: 16px;

      .password-rules {
        margin: 0;
        padding-left: 18px;
        font-size: 12px;
        line-height: 1.6;
        color: var(--td-text-color-secondary);

        li.ok {
          color: var(--td-success-color);
        }
      }

      .field-error {
        margin: -8px 0 0;
        color: var(--td-error-color);
        font-size: 13px;
      }

      .captcha-row {
        display: grid;
        grid-template-columns: 1fr 128px;
        gap: 12px;
      }

      .captcha-image {
        width: 128px;
        height: 40px;
        cursor: pointer;
        // 中文注释：中央验证码可能带透明通道，固定白底避免暗色登录卡片吞掉字符。
        background: #fff;
        border-radius: 8px;
      }

      .central-service-error {
        margin: 0;
        color: var(--td-error-color);
        font-size: 14px;
        line-height: 1.5;
      }

      :deep(.t-input) {
        border-radius: 8px;
      }
    }
  }
}

.stable-update-warning {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--td-warning-color);
}

.settingBtn {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 9999;
}
</style>

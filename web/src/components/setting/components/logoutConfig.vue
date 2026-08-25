<template>
  <div class="personal-center">
    <section class="personal-card">
      <h3>个人资料</h3>
      <div class="form-grid">
        <label for="profile-username">用户名</label>
        <t-input id="profile-username" v-model="profileForm.username" maxlength="32" />
        <label for="profile-nickname">昵称</label>
        <t-input id="profile-nickname" v-model="profileForm.nickname" maxlength="64" />
      </div>
      <t-button theme="primary" :loading="profileLoading" @click="saveProfile">
        保存个人资料
      </t-button>
    </section>

    <section class="personal-card">
      <h3>修改密码</h3>
      <div class="form-grid">
        <label for="old-password">原密码</label>
        <t-input id="old-password" v-model="passwordForm.oldPassword" type="password" maxlength="72" />
        <label for="new-password">新密码</label>
        <t-input id="new-password" v-model="passwordForm.newPassword" type="password" maxlength="72" />
        <label for="confirm-password">确认密码</label>
        <t-input id="confirm-password" v-model="passwordForm.confirmPassword" type="password" maxlength="72" />
      </div>
      <t-button theme="primary" :loading="passwordLoading" @click="savePassword">
        修改密码
      </t-button>
    </section>

    <section class="personal-card personal-card--logout">
      <t-alert theme="warning" :message="$t('settings.logout.warning')" />
      <t-button theme="danger" :loading="logoutLoading" @click="openLogoutDialog">
        <template #icon><t-icon name="logout" /></template>
        {{ $t("settings.logout.logout") }}
      </t-button>
    </section>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { DialogPlugin } from "tdesign-vue-next";
import {
  centralLogout,
  centralUser,
  authActionErrorMessage,
  changeCentralPassword,
  updateCentralProfile,
} from "@/features/tianjiang/auth/client";

const router = useRouter();
const profileLoading = ref(false);
const passwordLoading = ref(false);
const logoutLoading = ref(false);
const profileForm = reactive({ username: "", nickname: "" });
const passwordForm = reactive({ oldPassword: "", newPassword: "", confirmPassword: "" });

watch(centralUser, (user) => {
  profileForm.username = user?.username ?? "";
  profileForm.nickname = user?.nickname ?? "";
}, { immediate: true });

async function saveProfile() {
  const username = profileForm.username.trim().toLowerCase();
  const nickname = profileForm.nickname.trim();
  if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username) || !nickname) {
    window.$message.warning("请输入有效的用户名和昵称");
    return;
  }
  profileLoading.value = true;
  try {
    await updateCentralProfile({ username, nickname });
    window.$message.success("个人资料修改成功");
  } catch (error) {
    window.$message.error(authActionErrorMessage(error, "个人资料修改失败"));
  } finally {
    profileLoading.value = false;
  }
}

async function savePassword() {
  if (!passwordForm.oldPassword) {
    window.$message.warning("请输入原密码");
    return;
  }
  if (passwordForm.newPassword !== passwordForm.confirmPassword) {
    window.$message.warning("两次输入的新密码不一致");
    return;
  }
  passwordLoading.value = true;
  try {
    await changeCentralPassword({
      oldPassword: passwordForm.oldPassword,
      newPassword: passwordForm.newPassword,
    });
    passwordForm.oldPassword = "";
    passwordForm.newPassword = "";
    passwordForm.confirmPassword = "";
    window.$message.success("密码修改成功");
  } catch (error) {
    window.$message.error(authActionErrorMessage(error, "密码修改失败"));
  } finally {
    passwordLoading.value = false;
  }
}

function openLogoutDialog() {
  const dialog = DialogPlugin.confirm({
    header: $t("settings.logout.logout"),
    body: $t("settings.logout.confirmLogout"),
    confirmBtn: { content: $t("settings.logout.logout"), theme: "danger" },
    cancelBtn: $t("common.cancel"),
    onConfirm: async () => {
      dialog.destroy();
      await handleLogout();
    },
    onClose: () => dialog.destroy(),
  });
}

async function handleLogout() {
  logoutLoading.value = true;
  try {
    await centralLogout();
    // 中文注释：退出后同时丢弃活动项目与列表请求态，避免下一账号沿用上一账号的本地状态。
    try {
      const { default: projectStore } = await import("@/stores/project");
      projectStore().resetSessionProjectState({ clearLocalList: true });
    } catch {
      // 项目 store 尚未初始化时不阻断退出登录。
    }
    window.$message.success($t("settings.logout.msg.logoutSuccess"));
    router.push("/login");
  } catch {
    window.$message.error($t("settings.logout.msg.logoutFailed"));
  } finally {
    logoutLoading.value = false;
  }
}
</script>

<style lang="scss" scoped>
.personal-center {
  display: grid;
  gap: 18px;
  max-width: 760px;
  padding: 10px 0 28px;
}

.personal-card {
  display: grid;
  gap: 16px;
  padding: 20px;
  border: 1px solid var(--td-component-border);
  border-radius: var(--td-radius-large, 9px);
  background: var(--td-bg-color-container);

  h3 { margin: 0; }
}

.form-grid {
  display: grid;
  grid-template-columns: 96px minmax(240px, 1fr);
  align-items: center;
  gap: 14px;
}

.personal-card--logout {
  align-items: start;
}

@media (max-width: 640px) {
  .form-grid { grid-template-columns: 1fr; }
}
</style>

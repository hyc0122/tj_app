<template>
  <div class="logout-config">
    <t-space direction="vertical" size="medium">
      <t-alert theme="warning" :message="$t('settings.logout.warning')" />
      <t-button theme="danger" :loading="loading" @click="openLogoutDialog">
        <template #icon>
          <t-icon name="logout" />
        </template>
        {{ $t("settings.logout.logout") }}
      </t-button>
    </t-space>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { DialogPlugin } from "tdesign-vue-next";
import { centralLogout } from "@/features/tianjiang/auth/client";

const router = useRouter();
const loading = ref(false);

function openLogoutDialog() {
  const dialog = DialogPlugin.confirm({
    header: $t("settings.logout.logout"),
    body: $t("settings.logout.confirmLogout"),
    confirmBtn: {
      content: $t("settings.logout.logout"),
      theme: "danger",
    },
    cancelBtn: $t("common.cancel"),
    onConfirm: async () => {
      dialog.destroy();
      await handleLogout();
    },
    onClose: () => dialog.destroy(),
  });
}

async function handleLogout() {
  loading.value = true;
  try {
    // 经本地网关销毁会话并清除持久化 token；账号密码按产品约定保留。
    await centralLogout();
    // 退出后丢弃活动项目与列表请求态，避免下一账号首页沿用陈旧 store/timer。
    try {
      const { default: projectStore } = await import("@/stores/project");
      projectStore().resetSessionProjectState({ clearLocalList: true });
    } catch {
      // store 不可用时不阻断退出。
    }
    window.$message.success($t("settings.logout.msg.logoutSuccess"));
    router.push("/login");
  } catch {
    window.$message.error($t("settings.logout.msg.logoutFailed"));
  } finally {
    loading.value = false;
  }
}
</script>

<style lang="scss" scoped>
.logout-config {
  padding: 10px 0;
}
</style>

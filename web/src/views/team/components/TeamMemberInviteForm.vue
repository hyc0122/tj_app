<template>
  <div class="invite-form-wrapper">
    <div class="invite-form">
      <t-input
        v-model="username"
        :placeholder="$t('teamPage.inviteeUsernamePlaceholder')"
        maxlength="32"
      />
      <t-select
        v-model="role"
        :options="roleOptions"
        :placeholder="$t('teamPage.selectRole')"
        class="role-select"
      />
      <t-button variant="outline" :loading="loading" @click="submit">
        {{ $t("teamPage.invite") }}
      </t-button>
    </div>
    <p v-if="result" class="invitation-result">
      {{ $t("teamPage.invitationResult", {
        username: result.inviteeUsername,
        status: invitationStatusText,
      }) }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type {
  InvitationResult,
  InviteRole,
} from "@/features/tianjiang/team/invitations";

const props = defineProps<{
  loading?: boolean;
  result?: InvitationResult;
}>();
const emit = defineEmits<{
  invite: [payload: { username: string; role: InviteRole }];
}>();

const { t, te } = useI18n();
const username = ref("");
const role = ref<InviteRole>("viewer");
const roleOptions = computed(() => [
  { label: t("teamPage.role.editor"), value: "editor" },
  { label: t("teamPage.role.viewer"), value: "viewer" },
]);
const invitationStatusText = computed(() => {
  const status = props.result?.status ?? "";
  const key = `teamPage.invitationStatus.${status}`;
  return status && te(key) ? t(key) : status;
});

function submit(): void {
  const name = username.value.trim();
  if (!name) return;
  emit("invite", { username: name, role: role.value });
  // 成功后由父级刷新；此处不清空，失败时保留输入
  if (!props.loading) {
    // 父级 loading 控制，成功后父级会 refresh
  }
}

defineExpose({
  clear() {
    username.value = "";
    role.value = "viewer";
  },
  setUsername(v: string) {
    username.value = v;
  },
});
</script>

<style scoped>
.invite-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.invite-form-wrapper {
  display: grid;
  gap: 8px;
}
.invitation-result {
  margin: 0;
  color: var(--td-success-color);
  font-size: 13px;
}
.role-select {
  width: 140px;
}
</style>

<template>
  <section class="pending">
    <header>
      <h3>{{ $t("teamPage.pending.title") }}</h3>
      <t-button size="small" variant="text" :loading="loading" @click="$emit('refresh')">
        {{ $t("teamPage.pending.refresh") }}
      </t-button>
    </header>
    <t-loading :loading="loading" size="small">
      <div v-if="items.length" class="list">
        <article v-for="item in items" :key="item.invitationUuid" class="row">
          <div>
            <strong>{{ item.teamName || item.teamUuid }}</strong>
            <span>
              {{ $t("teamPage.pending.meta", {
                role: $t(`teamPage.role.${item.role}`),
                user: item.inviterUsername || "-",
              }) }}
            </span>
          </div>
          <div class="ops">
            <t-button
              size="small"
              theme="primary"
              :loading="busyId === item.invitationUuid"
              @click="$emit('accept', item)"
            >
              {{ $t("teamPage.pending.accept") }}
            </t-button>
            <t-button
              size="small"
              variant="outline"
              :loading="busyId === item.invitationUuid"
              @click="$emit('reject', item)"
            >
              {{ $t("teamPage.pending.reject") }}
            </t-button>
          </div>
        </article>
      </div>
      <t-empty v-else :description="$t('teamPage.pending.empty')" />
    </t-loading>
  </section>
</template>

<script setup lang="ts">
import type { PendingInvitation } from "@/features/tianjiang/team/invitations";

defineProps<{
  items: PendingInvitation[];
  loading: boolean;
  busyId: string;
}>();

defineEmits<{
  refresh: [];
  accept: [item: PendingInvitation];
  reject: [item: PendingInvitation];
}>();
</script>

<style scoped>
.pending {
  margin: 16px 0 24px;
  padding: 12px;
  border: 1px solid var(--td-component-border, #e7e7e7);
  border-radius: 8px;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-top: 1px solid var(--td-component-border, #eee);
}
.row span {
  display: block;
  font-size: 12px;
  opacity: 0.75;
}
.ops {
  display: flex;
  gap: 8px;
  align-items: center;
}
</style>

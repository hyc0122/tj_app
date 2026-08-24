<template>
  <p class="legal-consent" data-testid="legal-consent-notice">
    <template v-if="mode === 'register'">
      {{ $t("login.legal.consentRegisterPrefix") }}
    </template>
    <template v-else>
      {{ $t("login.legal.consentLoginPrefix") }}
    </template>
    <button type="button" class="legal-consent__link" @click="emit('open', 'user_agreement')">
      {{ $t("login.legal.userAgreement") }}
    </button>
    {{ $t("login.legal.and") }}
    <button type="button" class="legal-consent__link" @click="emit('open', 'privacy_policy')">
      {{ $t("login.legal.privacyPolicy") }}
    </button>
  </p>
</template>

<script setup lang="ts">
import type { LegalDocumentType } from "@/features/tianjiang/legal/contracts";

defineProps<{
  mode: "login" | "register";
}>();

const emit = defineEmits<{
  open: [type: LegalDocumentType];
}>();
</script>

<style lang="scss" scoped>
.legal-consent {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--td-text-color-secondary);
  text-align: center;
}

.legal-consent__link {
  display: inline;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--td-brand-color);
  cursor: pointer;
  font: inherit;
  text-decoration: underline;
}
</style>

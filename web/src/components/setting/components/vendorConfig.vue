<template>
  <VendorWorkspace />
  <VendorModelDialog />
  <VendorImportDialogs />
</template>

<script setup lang="ts">
import VendorImportDialogs from "./vendorConfig/components/VendorImportDialogs.vue";
import VendorModelDialog from "./vendorConfig/components/VendorModelDialog.vue";
import VendorWorkspace from "./vendorConfig/components/VendorWorkspace.vue";
import {
  createVendorConfigContext,
  provideVendorConfigContext,
} from "./vendorConfig/vendorConfigContext";

// 页面主文件只负责组装；供应商密钥、模型和导入生命周期由独立 composable 管理。
provideVendorConfigContext(createVendorConfigContext());
</script>

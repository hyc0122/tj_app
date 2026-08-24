<template>
  <section class="dreaminaProviderPanel" data-layout="dreamina-product-panel">
    <header class="dreaminaHero">
      <div class="dreaminaHero__identity">
        <div class="dreaminaHero__mark" aria-hidden="true">梦</div>
        <div>
          <div class="dreaminaHero__eyebrow">DEVICE LOCAL MODEL SERVICE</div>
          <h3>{{ $t("settings.menu.dreaminaCli") }}</h3>
          <p>即梦官方 CLI 的安装、授权、账户与生成能力都保存在当前设备。</p>
        </div>
      </div>
      <div class="dreaminaHero__actions">
        <t-button
          variant="outline"
          data-action="official-docs"
          :disabled="Boolean(pendingAction)"
          @click="openOfficialDocs"
        >
          <template #icon><t-icon name="help-circle" /></template>
          {{ $t("settings.dreaminaCli.officialDocs") }}
        </t-button>
        <div class="dreaminaHero__enable">
          <span data-dreamina-enabled-state>{{ enabled ? $t("settings.dreaminaCli.enabledState") : $t("settings.dreaminaCli.disabledState") }}</span>
          <t-button
            variant="outline"
            data-action="set-dreamina-enabled"
            :disabled="Boolean(pendingAction)"
            @click="setDreaminaEnabled(!enabled)"
          >
            {{ enabled ? $t("settings.dreaminaCli.closeCli") : $t("settings.dreaminaCli.openCli") }}
          </t-button>
          <t-switch
            data-field="dreamina-enabled"
            :model-value="enabled"
            :disabled="Boolean(pendingAction)"
            @change="onVisibleSwitchChange"
          />
        </div>
        <t-button
          theme="primary"
          data-action="recheck"
          :loading="pendingAction === 'recheck'"
          :disabled="Boolean(pendingAction) && pendingAction !== 'recheck'"
          @click="requestAction('recheck')"
        >
          <template #icon><t-icon name="refresh" /></template>
          {{ $t("settings.dreaminaCli.recheck") }}
        </t-button>
      </div>
    </header>

    <div class="dreaminaSummary" aria-label="即梦 CLI 状态总览">
      <article class="summaryTile module-interactive--sm" data-summary="install">
        <span class="summaryTile__icon summaryTile__icon--purple"><t-icon name="cloud-download" /></span>
        <div><span>安装状态</span><strong>{{ installStateText }}</strong></div>
        <i :class="['statusDot', statusTone(status?.install?.state)]" />
      </article>
      <article
        class="summaryTile module-interactive--sm"
        data-summary="account"
        :data-account-display="accountDisplay"
        :data-account-verified="sessionLoginVerified && accountDisplay === 'logged_in' ? 'true' : 'false'"
      >
        <span class="summaryTile__icon summaryTile__icon--blue"><t-icon name="user-circle" /></span>
        <div><span>账户状态</span><strong>{{ accountStateText }}</strong></div>
        <i :class="['statusDot', statusTone('account')]" />
      </article>
      <article class="summaryTile module-interactive--sm" data-summary="target">
        <span class="summaryTile__icon summaryTile__icon--cyan"><t-icon name="desktop" /></span>
        <div><span>执行目标</span><strong>{{ executionTargetText }}</strong></div>
        <i class="statusDot statusDot--neutral" />
      </article>
      <article class="summaryTile module-interactive--sm" data-summary="queue">
        <span class="summaryTile__icon summaryTile__icon--green"><t-icon name="time" /></span>
        <div><span>任务队列</span><strong>{{ queueSummaryText }}</strong></div>
        <i :class="['statusDot', status?.queue?.paused ? 'statusDot--warning' : 'statusDot--success']" />
      </article>
    </div>

    <div
      v-if="feedback.message"
      :class="['dreaminaFeedback', `dreaminaFeedback--${feedback.type}`]"
      data-feedback="dreamina-action"
      role="status"
      aria-live="polite"
    >
      <t-icon :name="feedback.type === 'error' ? 'error-circle' : 'check-circle'" />
      <span>{{ feedback.message }}</span>
    </div>

    <div class="dreaminaCardGrid">
      <section class="dreaminaCard module-interactive--panel" data-section="install">
        <header class="cardHeader">
          <div>
            <span class="cardHeader__kicker">CLI RUNTIME</span>
            <h4>{{ $t("settings.dreaminaCli.installStatus") }}</h4>
          </div>
          <span :class="['stateBadge', statusTone(status?.install?.state)]">{{ installStateText }}</span>
        </header>
        <div class="installVisual">
          <span class="installVisual__icon"><t-icon name="terminal-rectangle" /></span>
          <div>
            <strong>{{ status?.install?.managed ? "受管安装" : "设备安装" }}</strong>
            <p>{{ status?.install?.reason || installGuidance }}</p>
          </div>
        </div>
        <dl class="metadataList">
          <div><dt>{{ $t("settings.dreaminaCli.version") }}</dt><dd>{{ displayOrMissing(status?.install?.version) }}</dd></div>
          <div><dt>{{ $t("settings.dreaminaCli.path") }}</dt><dd class="pathValue">{{ displayOrMissing(resolvedExecutablePath || status?.install?.executablePath) }}</dd></div>
          <div><dt>执行方式</dt><dd>{{ executionTargetText }}</dd></div>
        </dl>
        <label class="executablePathField">
          <span>{{ $t("settings.dreaminaCli.executablePathLabel") }}</span>
          <input
            v-model="executablePathDraft"
            data-field="executable-path"
            type="text"
            :disabled="Boolean(pendingAction)"
            placeholder="dreamina 或完整 dreamina.exe 路径"
          />
        </label>
        <div class="cardActions cardActions--wrap">
          <t-button
            variant="outline"
            data-action="save-path"
            :loading="pendingAction === 'savePath'"
            :disabled="Boolean(pendingAction) && pendingAction !== 'savePath'"
            @click="requestAction('savePath')"
          >
            {{ $t("settings.dreaminaCli.savePath") }}
          </t-button>
          <t-button
            variant="outline"
            data-action="check-cli"
            :loading="pendingAction === 'checkCli'"
            :disabled="Boolean(pendingAction) && pendingAction !== 'checkCli'"
            @click="requestAction('checkCli')"
          >
            {{ $t("settings.dreaminaCli.checkCli") }}
          </t-button>
          <t-button
            theme="primary"
            data-action="install"
            :loading="pendingAction === 'install'"
            :disabled="Boolean(pendingAction) && pendingAction !== 'install'"
            @click="requestAction('install')"
          >
            <template #icon><t-icon name="download" /></template>
            {{ $t("settings.dreaminaCli.installAction") }}
          </t-button>
          <t-button
            variant="outline"
            data-action="repair"
            :loading="pendingAction === 'repair'"
            :disabled="Boolean(pendingAction) && pendingAction !== 'repair'"
            @click="requestAction('repair')"
          >
            {{ $t("settings.dreaminaCli.repairAction") }}
          </t-button>
        </div>
      </section>

      <DreaminaEnvironmentPanel class="dreaminaCard module-interactive--panel" />

      <section class="dreaminaCard dreaminaCard--wide module-interactive--panel" data-section="account">
        <header class="cardHeader">
          <div>
            <span class="cardHeader__kicker">ACCOUNT & AUTHORIZATION</span>
            <h4>{{ $t("settings.dreaminaCli.loginStatus") }}</h4>
          </div>
          <span :class="['stateBadge', statusTone('account')]">{{ accountStateText }}</span>
        </header>
        <div class="accountOverview">
          <div class="accountIdentity">
            <span class="accountIdentity__avatar"><t-icon name="user" /></span>
            <div>
              <strong>{{ accountStateText }}</strong>
              <p>{{ status?.account?.reason || "登录后可读取积分与账户状态" }}</p>
            </div>
          </div>
          <div class="accountMetric"><span>{{ $t("settings.dreaminaCli.credits") }}</span><strong>{{ displayedPoints }}</strong></div>
          <div class="accountMetric"><span>{{ $t("settings.dreaminaCli.planName") }}</span><strong>{{ displayOrMissing(status?.account?.planName) }}</strong></div>
          <div class="accountMetric"><span>{{ $t("settings.dreaminaCli.expiresAt") }}</span><strong>{{ displayOrMissing(status?.account?.expiresAt) }}</strong></div>
        </div>
        <div class="cardActions cardActions--wrap">
          <t-button
            theme="primary"
            data-action="authorize"
            :loading="pendingAction === 'authorize'"
            :disabled="Boolean(pendingAction) && pendingAction !== 'authorize'"
            @click="requestAction('authorize')"
          >
            <template #icon><t-icon name="secured" /></template>
            {{ $t("settings.dreaminaCli.authorize") }}
          </t-button>
          <t-button variant="outline" data-action="copy-auth-url" :disabled="!authUri || Boolean(pendingAction)" @click="copyAuthorization('url')">
            {{ $t("settings.dreaminaCli.copyAuthUrl") }}
          </t-button>
          <t-button variant="outline" data-action="copy-user-code" :disabled="!authUserCode || Boolean(pendingAction)" @click="copyAuthorization('code')">
            {{ $t("settings.dreaminaCli.copyUserCode") }}
          </t-button>
          <t-button variant="outline" data-action="open-auth-browser" :disabled="!authUri || Boolean(pendingAction)" @click="openAuthorizationBrowser">
            {{ $t("settings.dreaminaCli.openBrowser") }}
          </t-button>
          <t-button
            variant="outline"
            data-action="check-login"
            :loading="pendingAction === 'checkLogin'"
            :disabled="Boolean(pendingAction) && pendingAction !== 'checkLogin'"
            @click="requestAction('checkLogin')"
          >
            {{ $t("settings.dreaminaCli.checkLogin") }}
          </t-button>
          <t-button
            variant="outline"
            data-action="refresh-account"
            :loading="pendingAction === 'refreshAccount'"
            :disabled="Boolean(pendingAction) && pendingAction !== 'refreshAccount'"
            @click="requestAction('refreshAccount')"
          >
            {{ $t("settings.dreaminaCli.refreshAccount") }}
          </t-button>
          <t-button
            theme="danger"
            variant="outline"
            data-action="logout"
            :loading="pendingAction === 'logout'"
            :disabled="Boolean(pendingAction) && pendingAction !== 'logout'"
            @click="requestAction('logout')"
          >
            {{ $t("settings.dreaminaCli.logout") }}
          </t-button>
        </div>
      </section>

      <section class="dreaminaCard module-interactive--panel" data-section="models">
        <header class="cardHeader">
          <div><span class="cardHeader__kicker">CAPABILITIES</span><h4>{{ $t("settings.dreaminaCli.modelList") }}</h4></div>
          <span class="stateBadge statusDot--neutral">{{ modelNames.length }} 项</span>
        </header>
        <div v-if="modelNames.length" class="capabilityTags">
          <t-tag v-for="name in modelNames" :key="name" theme="primary" variant="light">{{ name }}</t-tag>
        </div>
        <div v-else class="emptyState">
          <t-icon name="image" />
          <strong>尚未探测模型能力</strong>
          <p>安装 CLI 后点击“重新检测”，模型与生成模式会显示在这里。</p>
        </div>
      </section>

      <section class="dreaminaCard module-interactive--panel" data-section="queue">
        <header class="cardHeader">
          <div><span class="cardHeader__kicker">LOCAL QUEUE</span><h4>{{ $t("settings.dreaminaCli.queueStatus") }}</h4></div>
          <span :class="['stateBadge', status?.queue?.paused ? 'statusDot--warning' : 'statusDot--success']">
            {{ status?.queue?.paused ? $t("settings.dreaminaCli.paused") : $t("settings.dreaminaCli.queueActive") }}
          </span>
        </header>
        <div class="queueMetrics">
          <div><strong>{{ status?.queue?.queued ?? 0 }}</strong><span>排队中</span></div>
          <div><strong>{{ status?.queue?.active ?? 0 }}</strong><span>生成中</span></div>
          <div><strong>{{ status?.queue?.unknown ?? 0 }}</strong><span>待确认</span></div>
          <div><strong>{{ status?.queue?.maxConcurrency ?? 1 }}</strong><span>并发上限</span></div>
        </div>
        <p class="queueReason" :data-queue-pause-reason="queuePauseReason">{{ queuePauseReasonText }}</p>
        <div class="queueControls">
          <label class="queueControls__field">
            <span>并发上限（1—8）</span>
            <input
              v-model.number="maxConcurrencyDraft"
              data-field="max-concurrency"
              type="number"
              min="1"
              max="8"
              step="1"
              :disabled="Boolean(pendingAction)"
            >
          </label>
          <t-button
            variant="outline"
            data-action="save-concurrency"
            :loading="pendingAction === 'saveConcurrency'"
            :disabled="Boolean(pendingAction) && pendingAction !== 'saveConcurrency'"
            @click="saveMaxConcurrency"
          >保存并发</t-button>
          <label class="queueControls__field">
            <span>轮询间隔（5—300 秒）</span>
            <input
              v-model.number="pollSecondsDraft"
              data-field="poll-seconds"
              type="number"
              min="5"
              max="300"
              step="1"
              :disabled="Boolean(pendingAction)"
            >
          </label>
          <t-button
            variant="outline"
            data-action="save-poll-seconds"
            :loading="pendingAction === 'savePollSeconds'"
            :disabled="Boolean(pendingAction) && pendingAction !== 'savePollSeconds'"
            @click="savePollSeconds"
          >保存轮询</t-button>
          <t-button
            v-if="enabled && queuePauseReason === 'manual_pause'"
            variant="outline"
            data-action="resume-queue"
            :loading="pendingAction === 'resumeQueue'"
            :disabled="Boolean(pendingAction) && pendingAction !== 'resumeQueue'"
            @click="setQueuePaused(false)"
          >恢复自动领取</t-button>
          <t-button
            v-else-if="enabled && queuePauseReason === 'none'"
            variant="outline"
            data-action="pause-queue"
            :loading="pendingAction === 'pauseQueue'"
            :disabled="Boolean(pendingAction) && pendingAction !== 'pauseQueue'"
            @click="setQueuePaused(true)"
          >手动暂停</t-button>
        </div>
        <p class="queueHint">即梦 CLI 不是常驻后台服务；启用后由本地调度器自动领取任务，并按任务启动 CLI。</p>
        <p class="queueHint">任务按当前账号稳定排队；即梦运行态不会同步到其他设备。</p>
      </section>
    </div>

    <DreaminaAuthorizationDialog
      v-model:visible="authVisible"
      :verification-uri="authUri"
      :user-code="authUserCode"
      :expires-at="authExpiresAt"
      :checking="pendingAction === 'checkAuthorization'"
      @copy-url="copyAuthorization('url')"
      @copy-code="copyAuthorization('code')"
      @open-browser="openAuthorizationBrowser"
      @check="checkAuthorization(true)"
    />
  </section>
</template>

<script setup lang="ts">
import DreaminaEnvironmentPanel from "./DreaminaEnvironmentPanel.vue";
import DreaminaAuthorizationDialog from "./DreaminaAuthorizationDialog.vue";
import { useDreaminaProviderPanel } from "./useDreaminaProviderPanel";

const {
  status,
  enabled,
  setDreaminaEnabled,
  reloadStatus,
  executablePathDraft,
  resolvedExecutablePath,
  sessionLoginVerified,
  accountDisplay,
  displayedPoints,
  pendingAction,
  feedback,
  authVisible,
  authUri,
  authUserCode,
  authExpiresAt,
  installStateText,
  accountStateText,
  executionTargetText,
  queueSummaryText,
  queuePauseReason,
  queuePauseReasonText,
  maxConcurrencyDraft,
  pollSecondsDraft,
  modelNames,
  installGuidance,
  statusTone,
  displayOrMissing,
  requestAction,
  setQueuePaused,
  saveMaxConcurrency,
  savePollSeconds,
  copyAuthorization,
  openAuthorizationBrowser,
  openOfficialDocs,
  checkAuthorization,
} = useDreaminaProviderPanel();

function onVisibleSwitchChange(value: boolean | string | number) {
  void setDreaminaEnabled(value === true || value === 1 || value === "1");
}

void reloadStatus;
</script>

<style lang="scss" src="../styles/dreamina-provider-panel.scss"></style>

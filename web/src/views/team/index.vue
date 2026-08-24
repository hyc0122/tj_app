<template>
  <section class="team-page">
    <header>
      <div>
        <h2>{{ $t("teamPage.title") }}</h2>
        <p>{{ $t("teamPage.description") }}</p>
      </div>
      <div class="create">
        <t-input v-model="newTeamName" :placeholder="$t('teamPage.teamNamePlaceholder')" maxlength="120" />
        <t-button :loading="loading" @click="handleCreate">{{ $t("teamPage.create") }}</t-button>
      </div>
    </header>

    <t-alert theme="info">{{ $t("teamPage.adminHint") }}</t-alert>

    <!-- 本人待处理邀请：刷新即可看到，无需输入团队编号 -->
    <PendingInvitations
      :items="pending"
      :loading="pendingLoading"
      :busy-id="busyInvitationId"
      @refresh="loadPending"
      @accept="handleAcceptPending"
      @reject="handleRejectPending"
    />

    <t-loading :loading="loading" show-overlay>
      <div v-if="teams.length" class="team-grid">
        <article v-for="team in teams" :key="team.teamUuid" class="team-card module-interactive" tabindex="0">
          <div class="team-title">
            <div>
              <h3>{{ team.name }}</h3>
              <span>{{ $t("teamPage.teamId", { id: team.teamUuid }) }}</span>
            </div>
            <t-tag :theme="isOwner(team) ? 'success' : 'default'">
              {{ $t(`teamPage.role.${team.myRole}`) }}
            </t-tag>
          </div>

          <div class="member-list">
            <div v-for="member in team.members" :key="member.userId" class="member-row">
              <div>
                <strong>{{ member.userName }}</strong>
                <span>{{ $t("teamPage.userId", { id: member.userId }) }}</span>
              </div>
              <t-tag>{{ $t(`teamPage.role.${member.role}`) }}</t-tag>
              <template v-if="isOwner(team) && member.role !== 'owner'">
                <t-select
                  v-model="memberRoles[memberKey(team, member)]"
                  :options="roleOptions"
                  :placeholder="$t('teamPage.selectRole')"
                />
                <t-button variant="outline" @click="handleRoleChange(team, member)">
                  {{ $t("teamPage.changeRole") }}
                </t-button>
                <t-button theme="danger" variant="outline" @click="handleRemove(team, member)">
                  {{ $t("teamPage.remove") }}
                </t-button>
                <t-button theme="warning" variant="outline" @click="handleTransfer(team, member)">
                  {{ $t("teamPage.transfer") }}
                </t-button>
              </template>
            </div>
          </div>

          <template v-if="isOwner(team)">
            <div class="operation">
              <TeamMemberInviteForm
                :ref="(el) => setInviteRef(team.teamUuid, el)"
                :loading="loading"
                :result="invitationResults[team.teamUuid]"
                @invite="(p) => handleInvite(team, p)"
              />
            </div>
            <div class="danger-zone">
              <t-button theme="danger" @click="handleDissolve(team)">{{ $t("teamPage.dissolve") }}</t-button>
            </div>
          </template>
        </article>
      </div>
      <t-empty v-else :description="$t('teamPage.empty')" />
    </t-loading>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { MessagePlugin } from "tdesign-vue-next";
import {
  changeTeamMemberRole,
  createTeam,
  dissolveTeam,
  listTeams,
  removeTeamMember,
  transferTeamOwnership,
  type Team,
  type TeamMember,
} from "@/features/tianjiang/team/client";
import {
  acceptInvitation,
  inviteTeamMemberByUsername,
  listMyPendingInvitations,
  mapInvitationErrorKey,
  rejectInvitation,
  type InviteRole,
  type InvitationResult,
  type PendingInvitation,
} from "@/features/tianjiang/team/invitations";
import PendingInvitations from "./components/PendingInvitations.vue";
import TeamMemberInviteForm from "./components/TeamMemberInviteForm.vue";

const { t } = useI18n();
const loading = ref(false);
const pendingLoading = ref(false);
const teams = ref<Team[]>([]);
const pending = ref<PendingInvitation[]>([]);
const newTeamName = ref("");
const busyInvitationId = ref("");
const memberRoles = reactive<Record<string, "editor" | "viewer">>({});
const inviteRefs = reactive<Record<string, { clear?: () => void } | null>>({});
const invitationResults = reactive<Record<string, InvitationResult | undefined>>({});

const roleOptions = computed(() => [
  { label: t("teamPage.role.editor"), value: "editor" },
  { label: t("teamPage.role.viewer"), value: "viewer" },
]);

function setInviteRef(teamUuid: string, el: unknown): void {
  inviteRefs[teamUuid] = (el as { clear?: () => void }) || null;
}

function ensureRoles(): void {
  for (const team of teams.value) {
    for (const member of team.members ?? []) {
      if (member.role !== "owner") memberRoles[memberKey(team, member)] = member.role;
    }
  }
}

function isOwner(team: Team): boolean {
  return team.myRole === "owner";
}

function memberKey(team: Team, member: TeamMember): string {
  return `${team.teamUuid}:${member.userId}`;
}

async function loadPending(): Promise<void> {
  pendingLoading.value = true;
  try {
    pending.value = await listMyPendingInvitations();
  } catch {
    // 待办失败不抹掉团队列表
    MessagePlugin.error(t("teamPage.error.pendingLoad"));
  } finally {
    pendingLoading.value = false;
  }
}

async function refreshTeams(): Promise<void> {
  loading.value = true;
  try {
    teams.value = await listTeams();
    ensureRoles();
  } catch (error: any) {
    MessagePlugin.error(error?.message ?? t("teamPage.error.load"));
  } finally {
    loading.value = false;
  }
}

/** 并行加载：一侧失败不影响另一侧成功数据 */
async function refreshAll(): Promise<void> {
  await Promise.all([refreshTeams(), loadPending()]);
}
type ActionErrorMapper = (error: unknown) => string;
async function runAction(action: () => Promise<void>, success: string, mapError: ActionErrorMapper): Promise<void> {
  loading.value = true;
  try {
    await action();
    MessagePlugin.success(success);
    await refreshAll();
  } catch (error: any) {
    MessagePlugin.error(t(mapError(error)));
  } finally {
    loading.value = false;
  }
}
/** 创建、改角色、移除、转让和解散只能使用通用团队错误。 */
function runTeamAction(action: () => Promise<void>, success: string): Promise<void> {
  return runAction(action, success, () => "teamPage.error.operation");
}

/** 只有邀请动作允许解释 INVITEE_*、成员已存在等邀请错误码。 */
function runInvitationAction(action: () => Promise<void>, success: string): Promise<void> {
  return runAction(action, success, mapInvitationErrorKey);
}

async function handleCreate(): Promise<void> {
  const name = newTeamName.value.trim();
  if (!name) return void MessagePlugin.warning(t("teamPage.error.nameRequired"));
  await runTeamAction(async () => {
    await createTeam(name);
    newTeamName.value = "";
  }, t("teamPage.success.created"));
}

async function handleInvite(
  team: Team,
  payload: { username: string; role: InviteRole },
): Promise<void> {
  await runInvitationAction(async () => {
    invitationResults[team.teamUuid] = await inviteTeamMemberByUsername(
      team.teamUuid,
      payload.username,
      payload.role,
    );
    inviteRefs[team.teamUuid]?.clear?.();
  }, t("teamPage.success.invited"));
}

async function handleAcceptPending(item: PendingInvitation): Promise<void> {
  busyInvitationId.value = item.invitationUuid;
  try {
    await acceptInvitation(item.invitationUuid);
    MessagePlugin.success(t("teamPage.success.joined"));
    pending.value = pending.value.filter((p) => p.invitationUuid !== item.invitationUuid);
    await refreshTeams();
  } catch (error: any) {
    MessagePlugin.error(t(mapInvitationErrorKey(error)));
  } finally {
    busyInvitationId.value = "";
  }
}

async function handleRejectPending(item: PendingInvitation): Promise<void> {
  busyInvitationId.value = item.invitationUuid;
  try {
    await rejectInvitation(item.invitationUuid);
    MessagePlugin.success(t("teamPage.success.rejected"));
    pending.value = pending.value.filter((p) => p.invitationUuid !== item.invitationUuid);
  } catch (error: any) {
    MessagePlugin.error(t(mapInvitationErrorKey(error)));
  } finally {
    busyInvitationId.value = "";
  }
}

async function handleRoleChange(team: Team, member: TeamMember): Promise<void> {
  await runTeamAction(
    () => changeTeamMemberRole(team.teamUuid, member.userId, memberRoles[memberKey(team, member)]),
    t("teamPage.success.roleChanged"),
  );
}

async function handleRemove(team: Team, member: TeamMember): Promise<void> {
  if (!window.confirm(t("teamPage.confirm.remove", { name: member.userName }))) return;
  await runTeamAction(
    () => removeTeamMember(team.teamUuid, member.userId),
    t("teamPage.success.removed"),
  );
}

async function handleTransfer(team: Team, member: TeamMember): Promise<void> {
  if (!window.confirm(t("teamPage.confirm.transfer", { name: member.userName }))) return;
  await runTeamAction(
    () => transferTeamOwnership(team.teamUuid, member.userId),
    t("teamPage.success.transferred"),
  );
}

async function handleDissolve(team: Team): Promise<void> {
  if (!window.confirm(t("teamPage.confirm.dissolve", { name: team.name }))) return;
  await runTeamAction(() => dissolveTeam(team.teamUuid), t("teamPage.success.dissolved"));
}

onMounted(refreshAll);
</script>

<style scoped lang="scss">
.team-page { padding: 8px 0 32px; color: var(--td-text-color-primary); }
header, .team-title, .operation, .danger-zone { display: flex; align-items: center; gap: 12px; }
header { justify-content: space-between; margin-bottom: 16px; }
header p, .team-title span, .member-row span { color: var(--td-text-color-secondary); }
.create { display: grid; grid-template-columns: 260px auto; gap: 8px; }
.team-grid { display: grid; gap: 16px; margin-top: 16px; }
.team-card { padding: 20px; border: 1px solid var(--td-component-border); border-radius: 12px; }
.member-list { display: grid; gap: 8px; margin-top: 16px; }
.member-row {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) auto 130px auto auto auto;
  align-items: center; gap: 8px; padding: 10px 12px;
  background: var(--td-bg-color-secondarycontainer); border-radius: 8px;
}
.member-row > div { display: grid; gap: 2px; }
.member-row span { font-size: 12px; }
.team-title { justify-content: space-between; }
.operation, .danger-zone { flex-wrap: wrap; margin-top: 16px; }
.danger-zone { padding-top: 16px; border-top: 1px dashed var(--td-error-color-4); }
</style>

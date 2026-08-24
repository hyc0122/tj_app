/** 此文件由 scripts/generate-contracts.mjs 自动生成，请勿手工修改。 */
export const CONTRACT_SCHEMA_VERSION = 1 as const;
export const CONTRACT_SOURCE_SHA256 = "10a1c854297fe4ff034df7076c66999f702d1395148c0912a5aa23b45f1d5a52" as const;
export const BUSINESS_USERNAME_PATTERN = "^[a-z0-9][a-z0-9_.-]{2,31}$" as const;

export const TEAM_ROLE_VALUES = ["owner","editor","viewer"] as const;
export type TeamRole = (typeof TEAM_ROLE_VALUES)[number];

export const TEAM_INVITATION_STATUS_VALUES = ["pending"] as const;
export type TeamInvitationStatus = (typeof TEAM_INVITATION_STATUS_VALUES)[number];

export const PROJECT_KIND_VALUES = ["personal","team"] as const;
export type ProjectKind = (typeof PROJECT_KIND_VALUES)[number];

export const PROJECT_BUSINESS_TYPE_VALUES = ["novel","script","storyboard"] as const;
export type ProjectBusinessType = (typeof PROJECT_BUSINESS_TYPE_VALUES)[number];

export const PROJECT_OPEN_MODE_VALUES = ["editable","readonly"] as const;
export type ProjectOpenMode = (typeof PROJECT_OPEN_MODE_VALUES)[number];

export const SYNC_STATE_VALUES = ["local_only","syncing","synced","conflict","failed","readonly"] as const;
export type SyncState = (typeof SYNC_STATE_VALUES)[number];

export const LOCK_STATUS_VALUES = ["none","active","released","expired","revoked"] as const;
export type LockStatus = (typeof LOCK_STATUS_VALUES)[number];

export const MEDIA_TYPE_VALUES = ["image","video","audio","text","binary"] as const;
export type MediaType = (typeof MEDIA_TYPE_VALUES)[number];

export type JSONPrimitive = string | number | boolean | null;
export type JSONValue = JSONPrimitive | { readonly [key: string]: JSONValue } | readonly JSONValue[];

export interface Device {
  deviceUuid: string;
  name: string;
  revokedAt: string | null;
}

export interface OfflineGrant {
  grantId: string;
  userId: number;
  deviceUuid: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface TeamMember {
  userId: number;
  username: string;
  nickname: string;
  role: TeamRole;
}

export interface TeamSummary {
  teamUuid: string;
  name: string;
  myRole: TeamRole;
  members: readonly TeamMember[];
}

export interface ProjectCatalogItem {
  projectUuid: string;
  name: string;
  kind: ProjectKind;
  ownerUserId: number;
  teamUuid?: string;
  teamName?: string;
  myRole: TeamRole;
  openMode: ProjectOpenMode;
  currentVersion: number;
  syncState: SyncState;
  lastSyncedAt: string | null;
  updatedAt: string;
  lockStatus: LockStatus;
  lockHolderName?: string;
  businessType: ProjectBusinessType;
  description?: string;
  artStyle?: string;
  aspectRatio?: string;
  defaultLanguage?: string;
  assetSourceProjectUuid?: string;
}

export interface TeamInvitationInboxItem {
  invitationUuid: string;
  status: string;
  inviteeUsername: string;
  inviterUsername: string;
  teamUuid: string;
  teamName: string;
  role: TeamRole;
  createdAt: string;
}

export interface ProjectObject {
  relativePath: string;
  objectKey: string;
  size: number;
  md5: string;
}

export interface ProjectDetail {
  projectUuid: string;
  name: string;
  kind: ProjectKind;
  myRole: TeamRole;
  openMode: ProjectOpenMode;
  currentVersion: number;
  objects: readonly ProjectObject[];
}

export interface LockView {
  lockId: string;
  fencingToken: number;
  expiresAt: string;
}

export interface ManifestDatabase {
  relative_path: string;
  size: number;
  md5: string;
}

export interface ManifestFile {
  relative_path: string;
  size: number;
  md5: string;
  media_type: MediaType;
}

export interface ExternalAssetReference {
  source_project_uuid: string;
  asset_uuid: string;
  asset_type: string;
  shot_uuid: string;
  relation_role: string;
}

export interface ProjectManifest {
  schema_version: number;
  project_uuid: string;
  version: number;
  base_version: number;
  created_at: string;
  database: ManifestDatabase;
  files: readonly ManifestFile[];
  external_asset_references?: readonly ExternalAssetReference[];
}

export interface PlannedUploadObject {
  relativePath: string;
  size: number;
  md5: string;
  crc64: string;
  uploadMode?: string;
}

export interface UploadObject {
  relativePath: string;
  objectKey: string;
  size: number;
  md5: string;
  verified: boolean;
}

export interface SignedHeaders {
  readonly [key: string]: string;
}

export interface ProfileSnapshot {
  schemaVersion: number;
  entries: JSONValue;
}

export interface DesktopReleaseChannelStatus {
  channel: string;
  healthy: boolean;
  version: string;
  tag: string;
  commitSha: string;
  sourceChannel: string;
  checkedAt: string;
  errorCode: string;
}

export interface ClientConfigOnboarding {
  guideRevision: number;
  supportQrCodeUrl: string;
}

export interface ClientConfigFeatureFlags {
  uiSettings: boolean;
  languageSettings: boolean;
  modelServices: boolean;
  modelMapping: boolean;
  agentConfig: boolean;
  promptManagement: boolean;
  skillsManagement: boolean;
  agentMemory: boolean;
  databaseOperations: boolean;
  fileManagement: boolean;
  otherConfiguration: boolean;
  developerOptions: boolean;
  checkUpdates: boolean;
  logout: boolean;
}

export interface ClientConfigUpdatePolicy {
  enabled: boolean;
  channel: string;
  manualDownloadOnly: boolean;
}

export interface ClientConfigSupport {
  feedbackUrl: string;
}

export interface PublicClientConfigRequest {

}

export interface PublicClientConfigResponseData {
  configVersion: number;
  updatedAt: string;
  onboarding: ClientConfigOnboarding;
  featureFlags: ClientConfigFeatureFlags;
  updatePolicy: ClientConfigUpdatePolicy;
  support: ClientConfigSupport;
}

export interface AdminGetClientConfigRequest {

}

export interface AdminGetClientConfigResponseData {
  configVersion: number;
  updatedAt: string;
  onboarding: ClientConfigOnboarding;
  featureFlags: ClientConfigFeatureFlags;
  updatePolicy: ClientConfigUpdatePolicy;
  support: ClientConfigSupport;
}

export interface AdminUpdateClientConfigRequest {
  onboarding: ClientConfigOnboarding;
  featureFlags: ClientConfigFeatureFlags;
  updatePolicy: ClientConfigUpdatePolicy;
  support: ClientConfigSupport;
  confirm: boolean;
}

export interface AdminUpdateClientConfigResponseData {
  configVersion: number;
  updatedAt: string;
  onboarding: ClientConfigOnboarding;
  featureFlags: ClientConfigFeatureFlags;
  updatePolicy: ClientConfigUpdatePolicy;
  support: ClientConfigSupport;
}

export interface AdminReleaseStatusRequest {
  platform: string;
  arch: string;
}

export interface AdminReleaseStatusResponseData {
  stable: DesktopReleaseChannelStatus;
  beta: DesktopReleaseChannelStatus;
}

export interface SessionRequest {

}

export interface SessionResponseData {
  userId: number;
  username: string;
}

export interface ListDevicesRequest {

}

export interface ListDevicesResponseData {
  devices: readonly Device[];
}

export interface RegisterDeviceRequest {
  deviceUuid: string;
  name: string;
  recoveryPublicKey?: string;
  publicFingerprint?: string;
}

export interface RegisterDeviceResponseData {
  deviceUuid: string;
  revokedAt: string | null;
}

export interface RevokeDeviceRequest {

}

export interface RevokeDeviceResponseData {

}

export interface IssueOfflineGrantRequest {
  deviceUuid: string;
  ttlSeconds: number;
}

export interface IssueOfflineGrantResponseData {
  grantId: string;
  userId: number;
  deviceUuid: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface ListTeamsRequest {

}

export interface ListTeamsResponseData {
  teams: readonly TeamSummary[];
}

export interface CreateTeamRequest {
  name: string;
}

export interface CreateTeamResponseData {
  teamUuid: string;
  name: string;
  myRole: TeamRole;
  members: readonly TeamMember[];
}

export interface ListTeamMembersRequest {

}

export interface ListTeamMembersResponseData {
  members: readonly TeamMember[];
}

export interface InviteTeamMemberRequest {
  username: string;
  role: TeamRole;
}

export interface InviteTeamMemberResponseData {
  invitationUuid: string;
  status: string;
  inviteeUsername: string;
  teamUuid: string;
  teamName: string;
  role: TeamRole;
  createdAt: string;
}

export interface AcceptTeamInvitationRequest {

}

export interface AcceptTeamInvitationResponseData {
  teamUuid: string;
  role: TeamRole;
}

export interface ListTeamInvitationsRequest {
  status?: TeamInvitationStatus;
}

export interface ListTeamInvitationsResponseData {
  invitations: readonly TeamInvitationInboxItem[];
}

export interface RejectTeamInvitationRequest {

}

export interface RejectTeamInvitationResponseData {

}

export interface RemoveTeamMemberRequest {

}

export interface RemoveTeamMemberResponseData {

}

export interface ChangeTeamMemberRoleRequest {
  role: TeamRole;
}

export interface ChangeTeamMemberRoleResponseData {

}

export interface TransferTeamOwnershipRequest {
  targetUserId: number;
  confirm: boolean;
}

export interface TransferTeamOwnershipResponseData {

}

export interface DissolveTeamRequest {
  confirm: boolean;
}

export interface DissolveTeamResponseData {

}

export interface ProjectCatalogRequest {

}

export interface ProjectCatalogResponseData {
  projects: readonly ProjectCatalogItem[];
}

export interface CreateProjectRequest {
  name: string;
  scope: ProjectKind;
  teamUuid?: string;
  businessType?: ProjectBusinessType;
  description?: string;
  artStyle?: string;
  aspectRatio?: string;
  defaultLanguage?: string;
  assetSourceProjectUuid?: string;
}

export interface CreateProjectResponseData {
  projectUuid: string;
  name: string;
  kind: ProjectKind;
  teamUuid?: string;
  teamName?: string;
  businessType?: ProjectBusinessType;
}

export interface GetProjectRequest {

}

export interface GetProjectResponseData {
  projectUuid: string;
  name: string;
  kind: ProjectKind;
  myRole: TeamRole;
  openMode: ProjectOpenMode;
  currentVersion: number;
  objects: readonly ProjectObject[];
}

export interface UpdateProjectRequest {
  name: string;
  businessType: ProjectBusinessType;
  description?: string;
  artStyle?: string;
  aspectRatio?: string;
  defaultLanguage?: string;
}

export interface UpdateProjectResponseData {
  projectUuid: string;
  name: string;
  kind: ProjectKind;
  ownerUserId: number;
  teamUuid?: string;
  teamName?: string;
  myRole: TeamRole;
  openMode: ProjectOpenMode;
  currentVersion: number;
  syncState: SyncState;
  lastSyncedAt: string | null;
  updatedAt: string;
  lockStatus: LockStatus;
  lockHolderName?: string;
  businessType: ProjectBusinessType;
  description?: string;
  artStyle?: string;
  aspectRatio?: string;
  defaultLanguage?: string;
  assetSourceProjectUuid?: string;
}

export interface DeleteProjectRequest {

}

export interface DeleteProjectResponseData {

}

export interface AcquireLockRequest {
  deviceUuid: string;
}

export interface AcquireLockResponseData {
  lockId: string;
  fencingToken: number;
  expiresAt: string;
}

export interface HeartbeatLockRequest {
  deviceUuid: string;
  lockId: string;
  fencingToken: number;
}

export interface HeartbeatLockResponseData {
  lockId: string;
  fencingToken: number;
  expiresAt: string;
}

export interface ReleaseLockRequest {
  deviceUuid: string;
  lockId: string;
  fencingToken: number;
  reason?: string;
}

export interface ReleaseLockResponseData {

}

export interface LatestManifestRequest {

}

export interface LatestManifestResponseData {
  manifest: ProjectManifest;
  objects: readonly ProjectObject[];
}

export interface CreateUploadSessionRequest {
  baseVersion: number;
  deviceUuid: string;
  lockId?: string;
  fencingToken?: number;
  objects: readonly PlannedUploadObject[];
}

export interface CreateUploadSessionResponseData {
  sessionUuid: string;
  expiresAt: string;
  objects: readonly UploadObject[];
}

export interface ConfirmUploadObjectRequest {
  relativePath: string;
  deviceUuid: string;
}

export interface ConfirmUploadObjectResponseData {

}

export interface CommitVersionRequest {
  deviceUuid: string;
  lockId?: string;
  fencingToken?: number;
  manifest: ProjectManifest;
}

export interface CommitVersionResponseData {
  version: number;
  manifest: ProjectManifest;
  objects: readonly ProjectObject[];
}

export interface FailUploadSessionRequest {
  failureCode: string;
}

export interface FailUploadSessionResponseData {

}

export interface ObjectAuthorizationRequest {
  method: string;
  projectUuid?: string;
  version?: number;
  sessionUuid?: string;
  relativePath: string;
  deviceUuid: string;
  expiresInSeconds: number;
}

export interface ObjectAuthorizationResponseData {
  url: string;
  expiresAt: string;
  signedHeaders: SignedHeaders;
}

export interface LatestProfileRequest {

}

export interface LatestProfileResponseData {
  version: number;
  snapshot: ProfileSnapshot;
}

export interface ProfileVersionMetadataRequest {

}

export interface ProfileVersionMetadataResponseData {
  version: number;
  etag: string;
  updatedAt?: string;
}

export interface CommitProfileRequest {
  baseVersion: number;
  snapshot: ProfileSnapshot;
}

export interface CommitProfileResponseData {
  version: number;
  snapshot: ProfileSnapshot;
}

export interface CurrentUserKeyEnvelopeRequest {

}

export interface CurrentUserKeyEnvelopeResponseData {
  userId: number;
  ciphertext: string;
  nonce: string;
  authTag: string;
  wrappingVersion: string;
}

export interface IssueUserKeyChallengeRequest {
  deviceUuid: string;
}

export interface IssueUserKeyChallengeResponseData {
  challengeId: string;
  challenge: string;
  signingPayload: string;
  expiresAt: string;
}

export interface RecoverUserDataKeyRequest {
  deviceUuid: string;
  challengeId: string;
  challenge: string;
  signature: string;
}

export interface RecoverUserDataKeyResponseData {
  deviceCiphertext: string;
  binding: string;
  keyVersion: string;
}

export interface APIEndpointTypes {
  publicClientConfig: { request: PublicClientConfigRequest; response: PublicClientConfigResponseData };
  adminGetClientConfig: { request: AdminGetClientConfigRequest; response: AdminGetClientConfigResponseData };
  adminUpdateClientConfig: { request: AdminUpdateClientConfigRequest; response: AdminUpdateClientConfigResponseData };
  adminReleaseStatus: { request: AdminReleaseStatusRequest; response: AdminReleaseStatusResponseData };
  session: { request: SessionRequest; response: SessionResponseData };
  listDevices: { request: ListDevicesRequest; response: ListDevicesResponseData };
  registerDevice: { request: RegisterDeviceRequest; response: RegisterDeviceResponseData };
  revokeDevice: { request: RevokeDeviceRequest; response: RevokeDeviceResponseData };
  issueOfflineGrant: { request: IssueOfflineGrantRequest; response: IssueOfflineGrantResponseData };
  listTeams: { request: ListTeamsRequest; response: ListTeamsResponseData };
  createTeam: { request: CreateTeamRequest; response: CreateTeamResponseData };
  listTeamMembers: { request: ListTeamMembersRequest; response: ListTeamMembersResponseData };
  inviteTeamMember: { request: InviteTeamMemberRequest; response: InviteTeamMemberResponseData };
  acceptTeamInvitation: { request: AcceptTeamInvitationRequest; response: AcceptTeamInvitationResponseData };
  listTeamInvitations: { request: ListTeamInvitationsRequest; response: ListTeamInvitationsResponseData };
  rejectTeamInvitation: { request: RejectTeamInvitationRequest; response: RejectTeamInvitationResponseData };
  removeTeamMember: { request: RemoveTeamMemberRequest; response: RemoveTeamMemberResponseData };
  changeTeamMemberRole: { request: ChangeTeamMemberRoleRequest; response: ChangeTeamMemberRoleResponseData };
  transferTeamOwnership: { request: TransferTeamOwnershipRequest; response: TransferTeamOwnershipResponseData };
  dissolveTeam: { request: DissolveTeamRequest; response: DissolveTeamResponseData };
  projectCatalog: { request: ProjectCatalogRequest; response: ProjectCatalogResponseData };
  createProject: { request: CreateProjectRequest; response: CreateProjectResponseData };
  getProject: { request: GetProjectRequest; response: GetProjectResponseData };
  updateProject: { request: UpdateProjectRequest; response: UpdateProjectResponseData };
  deleteProject: { request: DeleteProjectRequest; response: DeleteProjectResponseData };
  acquireLock: { request: AcquireLockRequest; response: AcquireLockResponseData };
  heartbeatLock: { request: HeartbeatLockRequest; response: HeartbeatLockResponseData };
  releaseLock: { request: ReleaseLockRequest; response: ReleaseLockResponseData };
  latestManifest: { request: LatestManifestRequest; response: LatestManifestResponseData };
  createUploadSession: { request: CreateUploadSessionRequest; response: CreateUploadSessionResponseData };
  confirmUploadObject: { request: ConfirmUploadObjectRequest; response: ConfirmUploadObjectResponseData };
  commitVersion: { request: CommitVersionRequest; response: CommitVersionResponseData };
  failUploadSession: { request: FailUploadSessionRequest; response: FailUploadSessionResponseData };
  objectAuthorization: { request: ObjectAuthorizationRequest; response: ObjectAuthorizationResponseData };
  latestProfile: { request: LatestProfileRequest; response: LatestProfileResponseData };
  profileVersionMetadata: { request: ProfileVersionMetadataRequest; response: ProfileVersionMetadataResponseData };
  commitProfile: { request: CommitProfileRequest; response: CommitProfileResponseData };
  currentUserKeyEnvelope: { request: CurrentUserKeyEnvelopeRequest; response: CurrentUserKeyEnvelopeResponseData };
  issueUserKeyChallenge: { request: IssueUserKeyChallengeRequest; response: IssueUserKeyChallengeResponseData };
  recoverUserDataKey: { request: RecoverUserDataKeyRequest; response: RecoverUserDataKeyResponseData };
}

export const CAPABILITY_VALUES = ["view_team","list_projects","download_project","create_project","acquire_edit_lock","publish_version","manage_members","change_member_role","delete_project","recover_project","force_release_lock","transfer_ownership","dissolve_team"] as const;
export type Capability = (typeof CAPABILITY_VALUES)[number];

export const TEAM_ROLE_CAPABILITIES: Readonly<Record<TeamRole, readonly Capability[]>> = Object.freeze({
  "owner": [
    "view_team",
    "list_projects",
    "download_project",
    "create_project",
    "acquire_edit_lock",
    "publish_version",
    "manage_members",
    "change_member_role",
    "delete_project",
    "recover_project",
    "force_release_lock",
    "transfer_ownership",
    "dissolve_team"
  ],
  "editor": [
    "view_team",
    "list_projects",
    "download_project",
    "create_project",
    "acquire_edit_lock",
    "publish_version"
  ],
  "viewer": [
    "view_team",
    "list_projects",
    "download_project"
  ]
});

export interface ManifestDatabase {
  relative_path: string;
  size: number;
  md5: string;
}

export interface ManifestFile {
  relative_path: string;
  size: number;
  md5: string;
  media_type: MediaType;
}

export interface ExternalAssetReferenceV1 {
  source_project_uuid: string;
  asset_uuid: string;
  asset_type: string;
  shot_uuid: string;
  relation_role: string;
}

export interface ProjectManifestV1 {
  schema_version: 1;
  project_uuid: string;
  version: number;
  base_version: number;
  created_at: string;
  database: ManifestDatabase;
  files: ManifestFile[];
  external_asset_references?: ExternalAssetReferenceV1[];
}

export interface EditLock {
  project_uuid: string;
  lock_id: string;
  holder_user_uuid: string;
  holder_device_uuid: string;
  fencing_token: number;
  issued_at: string;
  expires_at: string;
  last_heartbeat_at: string;
  status: LockStatus;
  release_reason: string;
}

export const ERROR_DEFINITIONS = [
  {
    "code": "AUTH_REQUIRED",
    "httpStatus": 401,
    "retryable": false,
    "message": "需要登录"
  },
  {
    "code": "ACCOUNT_DISABLED",
    "httpStatus": 403,
    "retryable": false,
    "message": "账号已禁用"
  },
  {
    "code": "DEVICE_NOT_FOUND",
    "httpStatus": 403,
    "retryable": false,
    "message": "设备未登记"
  },
  {
    "code": "DEVICE_REVOKED",
    "httpStatus": 403,
    "retryable": false,
    "message": "设备已撤销"
  },
  {
    "code": "PERMISSION_DENIED",
    "httpStatus": 403,
    "retryable": false,
    "message": "没有操作权限"
  },
  {
    "code": "PROJECT_NOT_FOUND",
    "httpStatus": 404,
    "retryable": false,
    "message": "项目不存在或不可见"
  },
  {
    "code": "TEAM_NOT_FOUND",
    "httpStatus": 404,
    "retryable": false,
    "message": "团队不存在或不可见"
  },
  {
    "code": "LOCK_HELD",
    "httpStatus": 409,
    "retryable": true,
    "message": "编辑锁已被占用"
  },
  {
    "code": "LOCK_EXPIRED",
    "httpStatus": 409,
    "retryable": true,
    "message": "编辑锁已过期"
  },
  {
    "code": "FENCING_TOKEN_STALE",
    "httpStatus": 409,
    "retryable": false,
    "message": "栅栏令牌已失效"
  },
  {
    "code": "BASE_VERSION_STALE",
    "httpStatus": 409,
    "retryable": false,
    "message": "基础版本已过期"
  },
  {
    "code": "UPLOAD_SESSION_EXPIRED",
    "httpStatus": 409,
    "retryable": true,
    "message": "上传会话已过期"
  },
  {
    "code": "VERSION_PROMOTION_IN_PROGRESS",
    "httpStatus": 409,
    "retryable": true,
    "message": "版本正在发布"
  },
  {
    "code": "OBJECT_CHECKSUM_MISMATCH",
    "httpStatus": 422,
    "retryable": true,
    "message": "对象摘要校验失败"
  },
  {
    "code": "SQLITE_INTEGRITY_FAILED",
    "httpStatus": 422,
    "retryable": false,
    "message": "SQLite 完整性校验失败"
  },
  {
    "code": "INSUFFICIENT_DISK_SPACE",
    "httpStatus": 507,
    "retryable": false,
    "message": "本地磁盘空间不足"
  },
  {
    "code": "STORAGE_UNAVAILABLE",
    "httpStatus": 503,
    "retryable": true,
    "message": "平台存储暂不可用"
  },
  {
    "code": "MIGRATION_FAILED",
    "httpStatus": 422,
    "retryable": false,
    "message": "数据迁移失败"
  },
  {
    "code": "INVALID_REQUEST",
    "httpStatus": 422,
    "retryable": false,
    "message": "请求参数无效"
  },
  {
    "code": "RATE_LIMITED",
    "httpStatus": 429,
    "retryable": true,
    "message": "请求太过频繁，请稍后再试"
  },
  {
    "code": "PROFILE_SNAPSHOT_INVALID",
    "httpStatus": 422,
    "retryable": false,
    "message": "个人配置快照无效"
  },
  {
    "code": "INTERNAL_ERROR",
    "httpStatus": 500,
    "retryable": true,
    "message": "中央服务内部错误"
  },
  {
    "code": "KEY_SERVICE_UNAVAILABLE",
    "httpStatus": 503,
    "retryable": true,
    "message": "个人密钥服务暂不可用"
  },
  {
    "code": "KEY_RECOVERY_DENIED",
    "httpStatus": 403,
    "retryable": false,
    "message": "当前设备无权恢复个人密钥"
  },
  {
    "code": "KEY_RECOVERY_CHALLENGE_EXPIRED",
    "httpStatus": 410,
    "retryable": true,
    "message": "密钥恢复挑战已过期"
  },
  {
    "code": "KEY_RECOVERY_CHALLENGE_USED",
    "httpStatus": 409,
    "retryable": false,
    "message": "密钥恢复挑战已使用"
  },
  {
    "code": "KEY_RECOVERY_FAILED",
    "httpStatus": 422,
    "retryable": false,
    "message": "个人密钥恢复失败"
  },
  {
    "code": "INVITEE_NOT_REGISTERED",
    "httpStatus": 422,
    "retryable": false,
    "message": "该用户尚未注册，请核实用户名后再邀请。"
  },
  {
    "code": "INVITEE_UNAVAILABLE",
    "httpStatus": 422,
    "retryable": false,
    "message": "该账号当前不可接受邀请。"
  },
  {
    "code": "TEAM_MEMBER_EXISTS",
    "httpStatus": 409,
    "retryable": false,
    "message": "团队成员已存在"
  },
  {
    "code": "INVITATION_NOT_FOUND",
    "httpStatus": 404,
    "retryable": false,
    "message": "邀请不存在或不可用"
  },
  {
    "code": "PROJECT_SCOPE_INVALID",
    "httpStatus": 422,
    "retryable": false,
    "message": "项目归属参数无效"
  },
  {
    "code": "TEAM_PROJECT_FORBIDDEN",
    "httpStatus": 403,
    "retryable": false,
    "message": "无权创建团队项目"
  }
] as const;
export type ErrorCode = (typeof ERROR_DEFINITIONS)[number]["code"];

export interface APIError {
  code: ErrorCode;
  message: string;
  request_id: string;
  retryable: boolean;
  details?: Record<string, string>;
}

export interface VersionCommitRequest {
  project_uuid: string;
  base_version: number;
  lock_id?: string;
  fencing_token?: number;
  upload_session_id: string;
  manifest: ProjectManifestV1;
}

export interface UserKeyEnvelope {
  userId: number;
  ciphertext: string;
  nonce: string;
  authTag: string;
  wrappingVersion: string;
}

export interface UserKeyRecoveryChallenge {
  challengeId: string;
  challenge: string;
  signingPayload: string;
  expiresAt: string;
}

export interface UserKeyRecoveryRequest {
  deviceUuid: string;
  challengeId: string;
  challenge: string;
  signature: string;
}

export interface UserKeyRecoveryResponse {
  deviceCiphertext: string;
  binding: string;
  keyVersion: string;
}

export const API_CONTRACT = Object.freeze({
  "basePath": "/api/tianjiang/v1",
  "clientBasePath": "/api",
  "requestIdHeader": "X-Request-ID",
  "lockIdHeader": "X-Tianjiang-Lock-ID",
  "fencingTokenHeader": "X-Tianjiang-Fencing-Token",
  "typeSchemas": {
    "Device": {
      "required": [
        "deviceUuid",
        "name",
        "revokedAt"
      ],
      "fields": {
        "deviceUuid": "UUID",
        "name": "String",
        "revokedAt": "NullableDateTime"
      }
    },
    "OfflineGrant": {
      "required": [
        "grantId",
        "userId",
        "deviceUuid",
        "expiresAt",
        "revokedAt"
      ],
      "fields": {
        "grantId": "UUID",
        "userId": "UInt",
        "deviceUuid": "UUID",
        "expiresAt": "DateTime",
        "revokedAt": "NullableDateTime"
      }
    },
    "TeamMember": {
      "required": [
        "userId",
        "username",
        "nickname",
        "role"
      ],
      "fields": {
        "userId": "UInt",
        "username": "String",
        "nickname": "String",
        "role": "TeamRole"
      }
    },
    "TeamSummary": {
      "required": [
        "teamUuid",
        "name",
        "myRole",
        "members"
      ],
      "fields": {
        "teamUuid": "UUID",
        "name": "String",
        "myRole": "TeamRole",
        "members": "TeamMember[]"
      }
    },
    "ProjectCatalogItem": {
      "required": [
        "projectUuid",
        "name",
        "kind",
        "ownerUserId",
        "myRole",
        "openMode",
        "currentVersion",
        "syncState",
        "lastSyncedAt",
        "updatedAt",
        "lockStatus",
        "businessType"
      ],
      "fields": {
        "projectUuid": "UUID",
        "name": "String",
        "kind": "ProjectKind",
        "ownerUserId": "UInt",
        "teamUuid": "UUID",
        "teamName": "String",
        "myRole": "TeamRole",
        "openMode": "ProjectOpenMode",
        "currentVersion": "UInt",
        "syncState": "SyncState",
        "lastSyncedAt": "NullableDateTime",
        "updatedAt": "DateTime",
        "lockStatus": "LockStatus",
        "lockHolderName": "String",
        "businessType": "ProjectBusinessType",
        "description": "String",
        "artStyle": "String",
        "aspectRatio": "String",
        "defaultLanguage": "String",
        "assetSourceProjectUuid": "UUID"
      }
    },
    "TeamInvitationInboxItem": {
      "required": [
        "invitationUuid",
        "status",
        "inviteeUsername",
        "inviterUsername",
        "teamUuid",
        "teamName",
        "role",
        "createdAt"
      ],
      "fields": {
        "invitationUuid": "UUID",
        "status": "String",
        "inviteeUsername": "String",
        "inviterUsername": "String",
        "teamUuid": "UUID",
        "teamName": "String",
        "role": "TeamRole",
        "createdAt": "DateTime"
      }
    },
    "ProjectObject": {
      "required": [
        "relativePath",
        "objectKey",
        "size",
        "md5"
      ],
      "fields": {
        "relativePath": "String",
        "objectKey": "String",
        "size": "UInt",
        "md5": "MD5"
      }
    },
    "ProjectDetail": {
      "required": [
        "projectUuid",
        "name",
        "kind",
        "myRole",
        "openMode",
        "currentVersion",
        "objects"
      ],
      "fields": {
        "projectUuid": "UUID",
        "name": "String",
        "kind": "ProjectKind",
        "myRole": "TeamRole",
        "openMode": "ProjectOpenMode",
        "currentVersion": "UInt",
        "objects": "ProjectObject[]"
      }
    },
    "LockView": {
      "required": [
        "lockId",
        "fencingToken",
        "expiresAt"
      ],
      "fields": {
        "lockId": "UUID",
        "fencingToken": "UInt",
        "expiresAt": "DateTime"
      }
    },
    "ManifestDatabase": {
      "required": [
        "relative_path",
        "size",
        "md5"
      ],
      "fields": {
        "relative_path": "String",
        "size": "UInt",
        "md5": "MD5"
      }
    },
    "ManifestFile": {
      "required": [
        "relative_path",
        "size",
        "md5",
        "media_type"
      ],
      "fields": {
        "relative_path": "String",
        "size": "UInt",
        "md5": "MD5",
        "media_type": "MediaType"
      }
    },
    "ExternalAssetReference": {
      "required": [
        "source_project_uuid",
        "asset_uuid",
        "asset_type",
        "shot_uuid",
        "relation_role"
      ],
      "fields": {
        "source_project_uuid": "UUID",
        "asset_uuid": "UUID",
        "asset_type": "String",
        "shot_uuid": "UUID",
        "relation_role": "String"
      }
    },
    "ProjectManifest": {
      "required": [
        "schema_version",
        "project_uuid",
        "version",
        "base_version",
        "created_at",
        "database",
        "files"
      ],
      "fields": {
        "schema_version": "UInt",
        "project_uuid": "UUID",
        "version": "UInt",
        "base_version": "UInt",
        "created_at": "DateTime",
        "database": "ManifestDatabase",
        "files": "ManifestFile[]",
        "external_asset_references": "ExternalAssetReference[]"
      }
    },
    "PlannedUploadObject": {
      "required": [
        "relativePath",
        "size",
        "md5",
        "crc64"
      ],
      "fields": {
        "relativePath": "String",
        "size": "UInt",
        "md5": "MD5",
        "crc64": "String",
        "uploadMode": "String"
      }
    },
    "UploadObject": {
      "required": [
        "relativePath",
        "objectKey",
        "size",
        "md5",
        "verified"
      ],
      "fields": {
        "relativePath": "String",
        "objectKey": "String",
        "size": "UInt",
        "md5": "MD5",
        "verified": "Boolean"
      }
    },
    "SignedHeaders": {
      "required": [],
      "fields": {},
      "additionalProperties": "String"
    },
    "ProfileSnapshot": {
      "required": [
        "schemaVersion",
        "entries"
      ],
      "fields": {
        "schemaVersion": "UInt",
        "entries": "JSONValue"
      }
    },
    "DesktopReleaseChannelStatus": {
      "required": [
        "channel",
        "healthy",
        "version",
        "tag",
        "commitSha",
        "sourceChannel",
        "checkedAt",
        "errorCode"
      ],
      "fields": {
        "channel": "String",
        "healthy": "Boolean",
        "version": "String",
        "tag": "String",
        "commitSha": "String",
        "sourceChannel": "String",
        "checkedAt": "DateTime",
        "errorCode": "String"
      }
    },
    "ClientConfigOnboarding": {
      "required": [
        "guideRevision",
        "supportQrCodeUrl"
      ],
      "fields": {
        "guideRevision": "UInt",
        "supportQrCodeUrl": "String"
      }
    },
    "ClientConfigFeatureFlags": {
      "required": [
        "uiSettings",
        "languageSettings",
        "modelServices",
        "modelMapping",
        "agentConfig",
        "promptManagement",
        "skillsManagement",
        "agentMemory",
        "databaseOperations",
        "fileManagement",
        "otherConfiguration",
        "developerOptions",
        "checkUpdates",
        "logout"
      ],
      "fields": {
        "uiSettings": "Boolean",
        "languageSettings": "Boolean",
        "modelServices": "Boolean",
        "modelMapping": "Boolean",
        "agentConfig": "Boolean",
        "promptManagement": "Boolean",
        "skillsManagement": "Boolean",
        "agentMemory": "Boolean",
        "databaseOperations": "Boolean",
        "fileManagement": "Boolean",
        "otherConfiguration": "Boolean",
        "developerOptions": "Boolean",
        "checkUpdates": "Boolean",
        "logout": "Boolean"
      }
    },
    "ClientConfigUpdatePolicy": {
      "required": [
        "enabled",
        "channel",
        "manualDownloadOnly"
      ],
      "fields": {
        "enabled": "Boolean",
        "channel": "String",
        "manualDownloadOnly": "Boolean"
      }
    },
    "ClientConfigSupport": {
      "required": [
        "feedbackUrl"
      ],
      "fields": {
        "feedbackUrl": "String"
      }
    }
  },
  "endpoints": {
    "publicClientConfig": {
      "method": "GET",
      "path": "/public/client-config",
      "security": "public",
      "requestFields": [],
      "responseFields": [
        "configVersion",
        "updatedAt",
        "onboarding",
        "featureFlags",
        "updatePolicy",
        "support"
      ],
      "requestTypes": {},
      "requestRequired": [],
      "responseTypes": {
        "configVersion": "UInt",
        "updatedAt": "DateTime",
        "onboarding": "ClientConfigOnboarding",
        "featureFlags": "ClientConfigFeatureFlags",
        "updatePolicy": "ClientConfigUpdatePolicy",
        "support": "ClientConfigSupport"
      },
      "responseRequired": [
        "configVersion",
        "updatedAt",
        "onboarding",
        "featureFlags",
        "updatePolicy",
        "support"
      ],
      "statuses": [
        200,
        304,
        500
      ]
    },
    "adminGetClientConfig": {
      "method": "GET",
      "basePath": "",
      "path": "/tianjiang/admin/client-config",
      "security": "admin",
      "requestFields": [],
      "responseFields": [
        "configVersion",
        "updatedAt",
        "onboarding",
        "featureFlags",
        "updatePolicy",
        "support"
      ],
      "requestTypes": {},
      "requestRequired": [],
      "responseTypes": {
        "configVersion": "UInt",
        "updatedAt": "DateTime",
        "onboarding": "ClientConfigOnboarding",
        "featureFlags": "ClientConfigFeatureFlags",
        "updatePolicy": "ClientConfigUpdatePolicy",
        "support": "ClientConfigSupport"
      },
      "responseRequired": [
        "configVersion",
        "updatedAt",
        "onboarding",
        "featureFlags",
        "updatePolicy",
        "support"
      ],
      "statuses": [
        200,
        401,
        403,
        500
      ]
    },
    "adminUpdateClientConfig": {
      "method": "PUT",
      "basePath": "",
      "path": "/tianjiang/admin/client-config",
      "security": "admin",
      "requestFields": [
        "onboarding",
        "featureFlags",
        "updatePolicy",
        "support",
        "confirm"
      ],
      "responseFields": [
        "configVersion",
        "updatedAt",
        "onboarding",
        "featureFlags",
        "updatePolicy",
        "support"
      ],
      "requestTypes": {
        "onboarding": "ClientConfigOnboarding",
        "featureFlags": "ClientConfigFeatureFlags",
        "updatePolicy": "ClientConfigUpdatePolicy",
        "support": "ClientConfigSupport",
        "confirm": "Boolean"
      },
      "requestRequired": [
        "onboarding",
        "featureFlags",
        "updatePolicy",
        "support",
        "confirm"
      ],
      "responseTypes": {
        "configVersion": "UInt",
        "updatedAt": "DateTime",
        "onboarding": "ClientConfigOnboarding",
        "featureFlags": "ClientConfigFeatureFlags",
        "updatePolicy": "ClientConfigUpdatePolicy",
        "support": "ClientConfigSupport"
      },
      "responseRequired": [
        "configVersion",
        "updatedAt",
        "onboarding",
        "featureFlags",
        "updatePolicy",
        "support"
      ],
      "statuses": [
        200,
        401,
        403,
        422,
        500
      ]
    },
    "adminReleaseStatus": {
      "method": "GET",
      "basePath": "",
      "path": "/tianjiang/admin/release-status",
      "security": "admin",
      "requestFields": [
        "platform",
        "arch"
      ],
      "responseFields": [
        "stable",
        "beta"
      ],
      "requestTypes": {
        "platform": "String",
        "arch": "String"
      },
      "requestRequired": [
        "platform",
        "arch"
      ],
      "responseTypes": {
        "stable": "DesktopReleaseChannelStatus",
        "beta": "DesktopReleaseChannelStatus"
      },
      "responseRequired": [
        "stable",
        "beta"
      ],
      "statuses": [
        200,
        401,
        403,
        422,
        500
      ]
    },
    "session": {
      "method": "GET",
      "path": "/session",
      "requestFields": [],
      "responseFields": [
        "userId",
        "username"
      ],
      "requestTypes": {},
      "requestRequired": [],
      "responseTypes": {
        "userId": "UInt",
        "username": "String"
      },
      "responseRequired": [
        "userId",
        "username"
      ],
      "statuses": [
        200,
        401,
        403
      ]
    },
    "listDevices": {
      "method": "GET",
      "path": "/devices",
      "requestFields": [],
      "responseFields": [
        "devices"
      ],
      "requestTypes": {},
      "requestRequired": [],
      "responseTypes": {
        "devices": "Device[]"
      },
      "responseRequired": [
        "devices"
      ],
      "statuses": [
        200,
        401
      ]
    },
    "registerDevice": {
      "method": "POST",
      "path": "/devices/register",
      "requestFields": [
        "deviceUuid",
        "name",
        "recoveryPublicKey",
        "publicFingerprint"
      ],
      "responseFields": [
        "deviceUuid",
        "revokedAt"
      ],
      "requestTypes": {
        "deviceUuid": "UUID",
        "name": "String",
        "recoveryPublicKey": "String",
        "publicFingerprint": "String"
      },
      "requestRequired": [
        "deviceUuid",
        "name"
      ],
      "responseTypes": {
        "deviceUuid": "UUID",
        "revokedAt": "NullableDateTime"
      },
      "responseRequired": [
        "deviceUuid",
        "revokedAt"
      ],
      "statuses": [
        200,
        401,
        403,
        422
      ]
    },
    "revokeDevice": {
      "method": "POST",
      "path": "/devices/:device_uuid/revoke",
      "requestFields": [],
      "responseFields": [],
      "requestTypes": {},
      "requestRequired": [],
      "responseTypes": {},
      "responseRequired": [],
      "statuses": [
        200,
        401,
        403,
        404
      ]
    },
    "issueOfflineGrant": {
      "method": "POST",
      "path": "/offline-grants",
      "requestFields": [
        "deviceUuid",
        "ttlSeconds"
      ],
      "responseFields": [
        "grantId",
        "userId",
        "deviceUuid",
        "expiresAt",
        "revokedAt"
      ],
      "requestTypes": {
        "deviceUuid": "UUID",
        "ttlSeconds": "UInt"
      },
      "requestRequired": [
        "deviceUuid",
        "ttlSeconds"
      ],
      "responseTypes": {
        "grantId": "UUID",
        "userId": "UInt",
        "deviceUuid": "UUID",
        "expiresAt": "DateTime",
        "revokedAt": "NullableDateTime"
      },
      "responseRequired": [
        "grantId",
        "userId",
        "deviceUuid",
        "expiresAt",
        "revokedAt"
      ],
      "statuses": [
        200,
        401,
        403,
        422
      ]
    },
    "listTeams": {
      "method": "GET",
      "path": "/teams",
      "requestFields": [],
      "responseFields": [
        "teams"
      ],
      "requestTypes": {},
      "requestRequired": [],
      "responseTypes": {
        "teams": "TeamSummary[]"
      },
      "responseRequired": [
        "teams"
      ],
      "statuses": [
        200,
        401
      ]
    },
    "createTeam": {
      "method": "POST",
      "path": "/teams",
      "requestFields": [
        "name"
      ],
      "responseFields": [
        "teamUuid",
        "name",
        "myRole",
        "members"
      ],
      "requestTypes": {
        "name": "String"
      },
      "requestRequired": [
        "name"
      ],
      "responseTypes": {
        "teamUuid": "UUID",
        "name": "String",
        "myRole": "TeamRole",
        "members": "TeamMember[]"
      },
      "responseRequired": [
        "teamUuid",
        "name",
        "myRole",
        "members"
      ],
      "statuses": [
        200,
        401,
        422
      ]
    },
    "listTeamMembers": {
      "method": "GET",
      "path": "/teams/:team_uuid/members",
      "requestFields": [],
      "responseFields": [
        "members"
      ],
      "requestTypes": {},
      "requestRequired": [],
      "responseTypes": {
        "members": "TeamMember[]"
      },
      "responseRequired": [
        "members"
      ],
      "statuses": [
        200,
        401,
        403,
        404
      ]
    },
    "inviteTeamMember": {
      "method": "POST",
      "path": "/teams/:team_uuid/invitations",
      "requestFields": [
        "username",
        "role"
      ],
      "responseFields": [
        "invitationUuid",
        "status",
        "inviteeUsername",
        "teamUuid",
        "teamName",
        "role",
        "createdAt"
      ],
      "requestTypes": {
        "username": "String",
        "role": "TeamRole"
      },
      "requestRequired": [
        "username",
        "role"
      ],
      "responseTypes": {
        "invitationUuid": "UUID",
        "status": "String",
        "inviteeUsername": "String",
        "teamUuid": "UUID",
        "teamName": "String",
        "role": "TeamRole",
        "createdAt": "DateTime"
      },
      "responseRequired": [
        "invitationUuid",
        "status",
        "inviteeUsername",
        "teamUuid",
        "teamName",
        "role",
        "createdAt"
      ],
      "statuses": [
        200,
        401,
        403,
        404,
        409,
        422,
        429
      ]
    },
    "acceptTeamInvitation": {
      "method": "POST",
      "path": "/team-invitations/:invitation_uuid/accept",
      "requestFields": [],
      "responseFields": [
        "teamUuid",
        "role"
      ],
      "requestTypes": {},
      "requestRequired": [],
      "responseTypes": {
        "teamUuid": "UUID",
        "role": "TeamRole"
      },
      "responseRequired": [
        "teamUuid",
        "role"
      ],
      "statuses": [
        200,
        401,
        403,
        404
      ]
    },
    "listTeamInvitations": {
      "method": "GET",
      "path": "/team-invitations",
      "requestFields": [
        "status"
      ],
      "responseFields": [
        "invitations"
      ],
      "requestTypes": {
        "status": "TeamInvitationStatus"
      },
      "requestRequired": [],
      "responseTypes": {
        "invitations": "TeamInvitationInboxItem[]"
      },
      "responseRequired": [
        "invitations"
      ],
      "statuses": [
        200,
        401
      ]
    },
    "rejectTeamInvitation": {
      "method": "POST",
      "path": "/team-invitations/:invitation_uuid/reject",
      "requestFields": [],
      "responseFields": [],
      "requestTypes": {},
      "requestRequired": [],
      "responseTypes": {},
      "responseRequired": [],
      "statuses": [
        200,
        401,
        404
      ]
    },
    "removeTeamMember": {
      "method": "DELETE",
      "path": "/teams/:team_uuid/members/:user_id",
      "requestFields": [],
      "responseFields": [],
      "requestTypes": {},
      "requestRequired": [],
      "responseTypes": {},
      "responseRequired": [],
      "statuses": [
        200,
        401,
        403,
        404
      ]
    },
    "changeTeamMemberRole": {
      "method": "PUT",
      "path": "/teams/:team_uuid/members/:user_id/role",
      "requestFields": [
        "role"
      ],
      "responseFields": [],
      "requestTypes": {
        "role": "TeamRole"
      },
      "requestRequired": [
        "role"
      ],
      "responseTypes": {},
      "responseRequired": [],
      "statuses": [
        200,
        401,
        403,
        404,
        422
      ]
    },
    "transferTeamOwnership": {
      "method": "POST",
      "path": "/teams/:team_uuid/transfer-ownership",
      "requestFields": [
        "targetUserId",
        "confirm"
      ],
      "responseFields": [],
      "requestTypes": {
        "targetUserId": "UInt",
        "confirm": "Boolean"
      },
      "requestRequired": [
        "targetUserId",
        "confirm"
      ],
      "responseTypes": {},
      "responseRequired": [],
      "statuses": [
        200,
        401,
        403,
        404,
        422
      ]
    },
    "dissolveTeam": {
      "method": "POST",
      "path": "/teams/:team_uuid/dissolve",
      "requestFields": [
        "confirm"
      ],
      "responseFields": [],
      "requestTypes": {
        "confirm": "Boolean"
      },
      "requestRequired": [
        "confirm"
      ],
      "responseTypes": {},
      "responseRequired": [],
      "statuses": [
        200,
        401,
        403,
        404,
        422
      ]
    },
    "projectCatalog": {
      "method": "GET",
      "path": "/projects",
      "requestFields": [],
      "responseFields": [
        "projects"
      ],
      "requestTypes": {},
      "requestRequired": [],
      "responseTypes": {
        "projects": "ProjectCatalogItem[]"
      },
      "responseRequired": [
        "projects"
      ],
      "statuses": [
        200,
        401
      ]
    },
    "createProject": {
      "method": "POST",
      "path": "/projects",
      "requestFields": [
        "name",
        "scope",
        "teamUuid",
        "businessType",
        "description",
        "artStyle",
        "aspectRatio",
        "defaultLanguage",
        "assetSourceProjectUuid"
      ],
      "responseFields": [
        "projectUuid",
        "name",
        "kind",
        "teamUuid",
        "teamName",
        "businessType"
      ],
      "requestTypes": {
        "name": "String",
        "scope": "ProjectKind",
        "teamUuid": "UUID",
        "businessType": "ProjectBusinessType",
        "description": "String",
        "artStyle": "String",
        "aspectRatio": "String",
        "defaultLanguage": "String",
        "assetSourceProjectUuid": "UUID"
      },
      "requestRequired": [
        "name",
        "scope"
      ],
      "responseTypes": {
        "projectUuid": "UUID",
        "name": "String",
        "kind": "ProjectKind",
        "teamUuid": "UUID",
        "teamName": "String",
        "businessType": "ProjectBusinessType"
      },
      "responseRequired": [
        "projectUuid",
        "name",
        "kind"
      ],
      "statuses": [
        200,
        401,
        403,
        422
      ]
    },
    "getProject": {
      "method": "GET",
      "path": "/projects/:project_uuid",
      "requestFields": [],
      "responseFields": [
        "projectUuid",
        "name",
        "kind",
        "myRole",
        "openMode",
        "currentVersion",
        "objects"
      ],
      "requestTypes": {},
      "requestRequired": [],
      "responseTypes": {
        "projectUuid": "UUID",
        "name": "String",
        "kind": "ProjectKind",
        "myRole": "TeamRole",
        "openMode": "ProjectOpenMode",
        "currentVersion": "UInt",
        "objects": "ProjectObject[]"
      },
      "responseRequired": [
        "projectUuid",
        "name",
        "kind",
        "myRole",
        "openMode",
        "currentVersion",
        "objects"
      ],
      "statuses": [
        200,
        401,
        403,
        404
      ]
    },
    "updateProject": {
      "method": "PATCH",
      "path": "/projects/:project_uuid",
      "requestFields": [
        "name",
        "businessType",
        "description",
        "artStyle",
        "aspectRatio",
        "defaultLanguage"
      ],
      "responseFields": [
        "projectUuid",
        "name",
        "kind",
        "ownerUserId",
        "teamUuid",
        "teamName",
        "myRole",
        "openMode",
        "currentVersion",
        "syncState",
        "lastSyncedAt",
        "updatedAt",
        "lockStatus",
        "lockHolderName",
        "businessType",
        "description",
        "artStyle",
        "aspectRatio",
        "defaultLanguage",
        "assetSourceProjectUuid"
      ],
      "requestTypes": {
        "name": "String",
        "businessType": "ProjectBusinessType",
        "description": "String",
        "artStyle": "String",
        "aspectRatio": "String",
        "defaultLanguage": "String"
      },
      "requestRequired": [
        "name",
        "businessType"
      ],
      "responseTypes": {
        "projectUuid": "UUID",
        "name": "String",
        "kind": "ProjectKind",
        "ownerUserId": "UInt",
        "teamUuid": "UUID",
        "teamName": "String",
        "myRole": "TeamRole",
        "openMode": "ProjectOpenMode",
        "currentVersion": "UInt",
        "syncState": "SyncState",
        "lastSyncedAt": "NullableDateTime",
        "updatedAt": "DateTime",
        "lockStatus": "LockStatus",
        "lockHolderName": "String",
        "businessType": "ProjectBusinessType",
        "description": "String",
        "artStyle": "String",
        "aspectRatio": "String",
        "defaultLanguage": "String",
        "assetSourceProjectUuid": "UUID"
      },
      "responseRequired": [
        "projectUuid",
        "name",
        "kind",
        "ownerUserId",
        "myRole",
        "openMode",
        "currentVersion",
        "syncState",
        "lastSyncedAt",
        "updatedAt",
        "lockStatus",
        "businessType"
      ],
      "statuses": [
        200,
        401,
        403,
        404,
        422
      ]
    },
    "deleteProject": {
      "method": "POST",
      "path": "/projects/:project_uuid/delete",
      "requestFields": [],
      "responseFields": [],
      "requestTypes": {},
      "requestRequired": [],
      "responseTypes": {},
      "responseRequired": [],
      "statuses": [
        200,
        401,
        403,
        404
      ]
    },
    "acquireLock": {
      "method": "POST",
      "path": "/projects/:project_uuid/lock",
      "requestFields": [
        "deviceUuid"
      ],
      "responseFields": [
        "lockId",
        "fencingToken",
        "expiresAt"
      ],
      "requestTypes": {
        "deviceUuid": "UUID"
      },
      "requestRequired": [
        "deviceUuid"
      ],
      "responseTypes": {
        "lockId": "UUID",
        "fencingToken": "UInt",
        "expiresAt": "DateTime"
      },
      "responseRequired": [
        "lockId",
        "fencingToken",
        "expiresAt"
      ],
      "statuses": [
        200,
        401,
        403,
        404,
        409
      ]
    },
    "heartbeatLock": {
      "method": "POST",
      "path": "/projects/:project_uuid/lock/heartbeat",
      "requestFields": [
        "deviceUuid",
        "lockId",
        "fencingToken"
      ],
      "responseFields": [
        "lockId",
        "fencingToken",
        "expiresAt"
      ],
      "requestTypes": {
        "deviceUuid": "UUID",
        "lockId": "UUID",
        "fencingToken": "UInt"
      },
      "requestRequired": [
        "deviceUuid",
        "lockId",
        "fencingToken"
      ],
      "responseTypes": {
        "lockId": "UUID",
        "fencingToken": "UInt",
        "expiresAt": "DateTime"
      },
      "responseRequired": [
        "lockId",
        "fencingToken",
        "expiresAt"
      ],
      "statuses": [
        200,
        401,
        403,
        404,
        409
      ]
    },
    "releaseLock": {
      "method": "DELETE",
      "path": "/projects/:project_uuid/lock",
      "requestFields": [
        "deviceUuid",
        "lockId",
        "fencingToken",
        "reason"
      ],
      "responseFields": [],
      "requestTypes": {
        "deviceUuid": "UUID",
        "lockId": "UUID",
        "fencingToken": "UInt",
        "reason": "String"
      },
      "requestRequired": [
        "deviceUuid",
        "lockId",
        "fencingToken"
      ],
      "responseTypes": {},
      "responseRequired": [],
      "statuses": [
        200,
        401,
        403,
        404,
        409
      ]
    },
    "latestManifest": {
      "method": "GET",
      "path": "/projects/:project_uuid/versions/latest",
      "requestFields": [],
      "responseFields": [
        "manifest",
        "objects"
      ],
      "requestTypes": {},
      "requestRequired": [],
      "responseTypes": {
        "manifest": "ProjectManifest",
        "objects": "ProjectObject[]"
      },
      "responseRequired": [
        "manifest",
        "objects"
      ],
      "statuses": [
        200,
        401,
        403,
        404
      ]
    },
    "createUploadSession": {
      "method": "POST",
      "path": "/projects/:project_uuid/upload-sessions",
      "requestFields": [
        "baseVersion",
        "deviceUuid",
        "lockId",
        "fencingToken",
        "objects"
      ],
      "responseFields": [
        "sessionUuid",
        "expiresAt",
        "objects"
      ],
      "requestTypes": {
        "baseVersion": "UInt",
        "deviceUuid": "UUID",
        "lockId": "UUID",
        "fencingToken": "UInt",
        "objects": "PlannedUploadObject[]"
      },
      "requestRequired": [
        "baseVersion",
        "deviceUuid",
        "objects"
      ],
      "responseTypes": {
        "sessionUuid": "UUID",
        "expiresAt": "DateTime",
        "objects": "UploadObject[]"
      },
      "responseRequired": [
        "sessionUuid",
        "expiresAt",
        "objects"
      ],
      "statuses": [
        200,
        401,
        403,
        404,
        409,
        422
      ]
    },
    "confirmUploadObject": {
      "method": "POST",
      "path": "/upload-sessions/:session_uuid/objects/confirm",
      "requestFields": [
        "relativePath",
        "deviceUuid"
      ],
      "responseFields": [],
      "requestTypes": {
        "relativePath": "String",
        "deviceUuid": "UUID"
      },
      "requestRequired": [
        "relativePath",
        "deviceUuid"
      ],
      "responseTypes": {},
      "responseRequired": [],
      "statuses": [
        200,
        401,
        403,
        404,
        409,
        422
      ]
    },
    "commitVersion": {
      "method": "POST",
      "path": "/upload-sessions/:session_uuid/commit",
      "requestFields": [
        "deviceUuid",
        "lockId",
        "fencingToken",
        "manifest"
      ],
      "responseFields": [
        "version",
        "manifest",
        "objects"
      ],
      "requestTypes": {
        "deviceUuid": "UUID",
        "lockId": "UUID",
        "fencingToken": "UInt",
        "manifest": "ProjectManifest"
      },
      "requestRequired": [
        "deviceUuid",
        "manifest"
      ],
      "responseTypes": {
        "version": "UInt",
        "manifest": "ProjectManifest",
        "objects": "ProjectObject[]"
      },
      "responseRequired": [
        "version",
        "manifest",
        "objects"
      ],
      "statuses": [
        200,
        401,
        403,
        404,
        409,
        422,
        503
      ]
    },
    "failUploadSession": {
      "method": "POST",
      "path": "/upload-sessions/:session_uuid/fail",
      "requestFields": [
        "failureCode"
      ],
      "responseFields": [],
      "requestTypes": {
        "failureCode": "String"
      },
      "requestRequired": [
        "failureCode"
      ],
      "responseTypes": {},
      "responseRequired": [],
      "statuses": [
        200,
        401,
        403,
        404,
        409
      ]
    },
    "objectAuthorization": {
      "method": "POST",
      "path": "/object-authorizations",
      "requestFields": [
        "method",
        "projectUuid",
        "version",
        "sessionUuid",
        "relativePath",
        "deviceUuid",
        "expiresInSeconds"
      ],
      "responseFields": [
        "url",
        "expiresAt",
        "signedHeaders"
      ],
      "requestTypes": {
        "method": "String",
        "projectUuid": "UUID",
        "version": "UInt",
        "sessionUuid": "UUID",
        "relativePath": "String",
        "deviceUuid": "UUID",
        "expiresInSeconds": "UInt"
      },
      "requestRequired": [
        "method",
        "relativePath",
        "deviceUuid",
        "expiresInSeconds"
      ],
      "responseTypes": {
        "url": "String",
        "expiresAt": "DateTime",
        "signedHeaders": "SignedHeaders"
      },
      "responseRequired": [
        "url",
        "expiresAt",
        "signedHeaders"
      ],
      "statuses": [
        200,
        401,
        403,
        404,
        409,
        422,
        503
      ]
    },
    "latestProfile": {
      "method": "GET",
      "path": "/profile/versions/latest",
      "requestFields": [],
      "responseFields": [
        "version",
        "snapshot"
      ],
      "requestTypes": {},
      "requestRequired": [],
      "responseTypes": {
        "version": "UInt",
        "snapshot": "ProfileSnapshot"
      },
      "responseRequired": [
        "version",
        "snapshot"
      ],
      "statuses": [
        200,
        401,
        404
      ]
    },
    "profileVersionMetadata": {
      "method": "GET",
      "path": "/profile/versions/metadata",
      "requestFields": [],
      "responseFields": [
        "version",
        "etag",
        "updatedAt"
      ],
      "requestTypes": {},
      "requestRequired": [],
      "responseTypes": {
        "version": "UInt",
        "etag": "String",
        "updatedAt": "DateTime"
      },
      "responseRequired": [
        "version",
        "etag"
      ],
      "statuses": [
        200,
        401,
        404
      ]
    },
    "commitProfile": {
      "method": "POST",
      "path": "/profile/versions",
      "requestFields": [
        "baseVersion",
        "snapshot"
      ],
      "responseFields": [
        "version",
        "snapshot"
      ],
      "requestTypes": {
        "baseVersion": "UInt",
        "snapshot": "ProfileSnapshot"
      },
      "requestRequired": [
        "baseVersion",
        "snapshot"
      ],
      "responseTypes": {
        "version": "UInt",
        "snapshot": "ProfileSnapshot"
      },
      "responseRequired": [
        "version",
        "snapshot"
      ],
      "statuses": [
        200,
        401,
        409,
        422
      ]
    },
    "currentUserKeyEnvelope": {
      "method": "GET",
      "path": "/profile-key/envelope",
      "requestFields": [],
      "responseFields": [
        "userId",
        "ciphertext",
        "nonce",
        "authTag",
        "wrappingVersion"
      ],
      "requestTypes": {},
      "requestRequired": [],
      "responseTypes": {
        "userId": "UInt",
        "ciphertext": "String",
        "nonce": "String",
        "authTag": "String",
        "wrappingVersion": "String"
      },
      "responseRequired": [
        "userId",
        "ciphertext",
        "nonce",
        "authTag",
        "wrappingVersion"
      ],
      "statuses": [
        200,
        401,
        403,
        404,
        503
      ]
    },
    "issueUserKeyChallenge": {
      "method": "POST",
      "path": "/profile-key/challenges",
      "requestFields": [
        "deviceUuid"
      ],
      "responseFields": [
        "challengeId",
        "challenge",
        "signingPayload",
        "expiresAt"
      ],
      "requestTypes": {
        "deviceUuid": "UUID"
      },
      "requestRequired": [
        "deviceUuid"
      ],
      "responseTypes": {
        "challengeId": "UUID",
        "challenge": "String",
        "signingPayload": "String",
        "expiresAt": "DateTime"
      },
      "responseRequired": [
        "challengeId",
        "challenge",
        "signingPayload",
        "expiresAt"
      ],
      "statuses": [
        200,
        401,
        403,
        422,
        503
      ]
    },
    "recoverUserDataKey": {
      "method": "POST",
      "path": "/profile-key/recover",
      "requestFields": [
        "deviceUuid",
        "challengeId",
        "challenge",
        "signature"
      ],
      "responseFields": [
        "deviceCiphertext",
        "binding",
        "keyVersion"
      ],
      "requestTypes": {
        "deviceUuid": "UUID",
        "challengeId": "UUID",
        "challenge": "String",
        "signature": "String"
      },
      "requestRequired": [
        "deviceUuid",
        "challengeId",
        "challenge",
        "signature"
      ],
      "responseTypes": {
        "deviceCiphertext": "String",
        "binding": "String",
        "keyVersion": "String"
      },
      "responseRequired": [
        "deviceCiphertext",
        "binding",
        "keyVersion"
      ],
      "statuses": [
        200,
        401,
        403,
        409,
        410,
        422,
        503
      ]
    }
  }
} as const);

export type APIEndpointName = keyof typeof API_CONTRACT.endpoints;
export type APIPathParameters = Readonly<Record<string, string | number>>;

// buildAPIPath 只从公共契约生成版本化路径，缺少参数或危险片段时立即失败。
export function buildAPIPath(
  name: APIEndpointName,
  parameters: APIPathParameters = {},
): string {
  const endpoint = API_CONTRACT.endpoints[name];
  const relativePath = endpoint.path.replace(/:([a-z_]+)/g, (_token, parameter: string) => {
    const value = parameters[parameter];
    if (value === undefined || value === null || String(value).length === 0) {
      throw new Error(`缺少契约路径参数：${parameter}`);
    }
    return encodeURIComponent(String(value));
  });
  if (relativePath.includes(":")) throw new Error(`契约路径参数未完全替换：${relativePath}`);
  const basePath = "basePath" in endpoint ? endpoint.basePath : API_CONTRACT.basePath;
  return `${basePath}${relativePath}`;
}

// buildClientAPIPath 供 baseURL 已指向本地 /api 的业务前端使用，避免重复 /api。
export function buildClientAPIPath(
  name: APIEndpointName,
  parameters: APIPathParameters = {},
): string {
  const fullPath = buildAPIPath(name, parameters);
  if (!fullPath.startsWith(`${API_CONTRACT.clientBasePath}/`)) {
    throw new Error("客户端 API Base 与公共契约不一致");
  }
  return fullPath.slice(API_CONTRACT.clientBasePath.length);
}

// matchAPIEndpoint 是 Node 代理的严格白名单，只接受契约声明的方法和完整版本化路径。
export function matchAPIEndpoint(method: string, pathname: string): APIEndpointName | null {
  if (!pathname.startsWith("/") || pathname.includes("?") || pathname.includes("#")) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.split("/").some((part) => part === "." || part === "..")) {
    return null;
  }
  for (const name of Object.keys(API_CONTRACT.endpoints) as APIEndpointName[]) {
    const endpoint = API_CONTRACT.endpoints[name];
    // 客户端代理不得转发 GVA 管理端点；管理 UI 直接使用生成的 API_CONTRACT。
    if ("security" in endpoint && endpoint.security === "admin") continue;
    if (endpoint.method !== method.toUpperCase()) continue;
    const basePath = "basePath" in endpoint ? endpoint.basePath : API_CONTRACT.basePath;
    const expectedParts = `${basePath}${endpoint.path}`.split("/");
    const actualParts = decoded.split("/");
    if (
      expectedParts.length === actualParts.length
      && expectedParts.every((part, index) => part.startsWith(":") || part === actualParts[index])
      && actualParts.every((part) => part.length > 0 || part === actualParts[0])
    ) return name;
  }
  return null;
}

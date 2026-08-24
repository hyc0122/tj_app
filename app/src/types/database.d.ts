// @db-hash 4cbfec51c57760225674e0fb67e29583
//该文件由脚本自动生成，请勿手动修改

export interface memories {
  'content': string;
  'createTime': number;
  'embedding'?: string | null;
  'id'?: string;
  'isolationKey': string;
  'name'?: string | null;
  'relatedMessageIds'?: string | null;
  'role'?: string | null;
  'summarized'?: number | null;
  'type': string;
}
export interface o_agentDeploy {
  'desc'?: string | null;
  'disabled'?: boolean | null;
  'id'?: number;
  'key'?: string | null;
  'maxOutputTokens'?: number | null;
  'model'?: string | null;
  'modelName'?: string | null;
  'name'?: string | null;
  'temperature'?: number | null;
  'type'?: string | null;
  'vendorId'?: string | null;
}
export interface o_agentWorkData {
  'createTime'?: number | null;
  'data'?: string | null;
  'episodesId'?: number | null;
  'id'?: number;
  'key'?: string | null;
  'projectId'?: number | null;
  'updateTime'?: number | null;
}
export interface o_artStyle {
  'fileUrl'?: string | null;
  'id'?: number;
  'label'?: string | null;
  'name'?: string | null;
  'prompt'?: string | null;
}
export interface o_assets {
  'assetUuid'?: string | null;
  'assetsId'?: number | null;
  'audioBindState'?: number | null;
  'describe'?: string | null;
  'flowId'?: number | null;
  'id'?: number;
  'imageId'?: number | null;
  'name'?: string | null;
  'projectId'?: number | null;
  'prompt'?: string | null;
  'promptErrorReason'?: string | null;
  'promptState'?: string | null;
  'remark'?: string | null;
  'scriptId'?: number | null;
  'startTime'?: number | null;
  'type'?: string | null;
}
export interface o_assets2Storyboard {
  'assetId'?: number;
  'storyboardId'?: number;
}
export interface o_assetsRole2Audio {
  'assetsAudioId'?: number;
  'assetsRoleId'?: number;
}
export interface o_event {
  'createTime'?: number | null;
  'detail'?: string | null;
  'id'?: number;
  'name'?: string | null;
}
export interface o_eventChapter {
  'eventId'?: number | null;
  'id'?: number;
  'novelId'?: number | null;
}
export interface o_image {
  'assetsId'?: number | null;
  'errorReason'?: string | null;
  'filePath'?: string | null;
  'id'?: number;
  'model'?: string | null;
  'resolution'?: string | null;
  'state'?: string | null;
  'type'?: string | null;
}
export interface o_imageFlow {
  'flowData': string;
  'id'?: number;
}
export interface o_modelPrompt {
  'fileName'?: string | null;
  'id'?: number;
  'model'?: string | null;
  'path'?: string | null;
  'vendorId'?: string | null;
}
export interface o_novel {
  'chapter'?: string | null;
  'chapterData'?: string | null;
  'chapterIndex'?: number | null;
  'createTime'?: number | null;
  'errorReason'?: string | null;
  'event'?: string | null;
  'eventState'?: number | null;
  'id'?: number;
  'projectId'?: number | null;
  'reel'?: string | null;
}
export interface o_project {
  'artStyle'?: string | null;
  'createTime'?: number | null;
  'directorManual'?: string | null;
  'id'?: number | null;
  'imageModel'?: string | null;
  'imageQuality'?: string | null;
  'intro'?: string | null;
  'mode'?: string | null;
  'name'?: string | null;
  'projectType'?: string | null;
  'type'?: string | null;
  'userId'?: number | null;
  'videoModel'?: string | null;
  'videoRatio'?: string | null;
}
export interface o_prompt {
  'data'?: string | null;
  'id'?: number;
  'name'?: string | null;
  'type'?: string | null;
  'useData'?: string | null;
}
export interface o_script {
  'content'?: string | null;
  'createTime'?: number | null;
  'errorReason'?: string | null;
  'extractState'?: number | null;
  'id'?: number;
  'name'?: string | null;
  'projectId'?: number | null;
}
export interface o_scriptAssets {
  'assetId'?: number;
  'scriptId'?: number;
}
export interface o_setting {
  'key'?: string | null;
  'value'?: string | null;
}
export interface o_skillAttribution {
  'attribution'?: string;
  'skillId'?: string;
}
export interface o_skillList {
  'createTime': number;
  'description': string;
  'embedding'?: string | null;
  'id'?: string;
  'md5': string;
  'name': string;
  'path': string;
  'state': number;
  'type': string;
  'updateTime': number;
}
export interface o_storyboard {
  'createTime'?: number | null;
  'duration'?: string | null;
  'filePath'?: string | null;
  'flowId'?: number | null;
  'id'?: number;
  'index'?: number | null;
  'projectId'?: number | null;
  'prompt'?: string | null;
  'reason'?: string | null;
  'scriptId'?: number | null;
  'shouldGenerateImage'?: number | null;
  'state'?: string | null;
  'track'?: string | null;
  'trackId'?: number | null;
  'videoDesc'?: string | null;
}
export interface o_tasks {
  'createdAt'?: number | null;
  'describe'?: string | null;
  'generationStatus'?: string | null;
  'id'?: number;
  'lastPollAt'?: number | null;
  'manualRetryRequired'?: number | null;
  'model'?: string | null;
  'projectId'?: number | null;
  'projectUuid'?: string | null;
  'provider'?: string | null;
  'reason'?: string | null;
  'recoveryAttemptedAt'?: number | null;
  'relatedObjects'?: string | null;
  'remoteStatusHint'?: string | null;
  'remoteTaskId'?: string | null;
  'requestDigest'?: string | null;
  'startTime'?: number | null;
  'state'?: string | null;
  'taskClass'?: string | null;
}
export interface o_user {
  'id'?: number;
  'name'?: string | null;
  'password'?: string | null;
}
export interface o_vendorConfig {
  'enable'?: number | null;
  'id'?: string;
  'inputValues'?: string | null;
  'models'?: string | null;
}
export interface o_video {
  'errorReason'?: string | null;
  'filePath'?: string | null;
  'generationTaskUuid'?: string | null;
  'id'?: number;
  'projectId'?: number | null;
  'scriptId'?: number | null;
  'state'?: string | null;
  'time'?: number | null;
  'videoTrackId'?: number | null;
}
export interface o_videoTrack {
  'duration'?: number | null;
  'id'?: number;
  'projectId'?: number | null;
  'prompt'?: string | null;
  'reason'?: string | null;
  'scriptId'?: number | null;
  'selectVideoId'?: number | null;
  'state'?: string | null;
  'videoId'?: number | null;
}
export interface o_storyboardShot {
  'id'?: number;
  'shotUuid': string;
  'displayOrder': number;
  'sourceText'?: string | null;
  'visualDescription'?: string | null;
  'imagePrompt'?: string | null;
  'videoPrompt'?: string | null;
  'negativePrompt'?: string | null;
  'shotSize'?: string | null;
  'cameraMovement'?: string | null;
  'composition'?: string | null;
  'era'?: string | null;
  'durationMs'?: number | null;
  'aspectRatio'?: string | null;
  'overrideJson'?: string | null;
  'createdAt': string;
  'updatedAt': string;
}
export interface o_storyboardShotAsset {
  'id'?: number;
  'shotUuid': string;
  'sourceProjectUuid': string;
  'assetUuid': string;
  'assetType': "role" | "scene" | "tool" | "clip" | "audio";
  'relationRole': string;
  'voiceEnabled'?: number;
}
export interface o_storyboardWorkspaceSettings {
  'id': number;
  'globalImagePrompt': string;
  'globalVideoPrompt': string;
  'globalNegativePrompt': string;
  'textModel'?: string | null;
  'imageModel'?: string | null;
  'videoModel'?: string | null;
  'aspectRatio': string;
  'resolution': string;
  'durationMs': number;
  'imageConcurrency': number;
  'videoConcurrency': number;
  'videoPromptTemplateId'?: number | null;
  'videoPromptTemplateContent'?: string | null;
}
export interface o_storyboardCandidate {
  'id'?: number;
  'candidateUuid': string;
  'shotUuid': string;
  'mediaType': "image" | "video";
  'relativePath': string;
  'selected': number;
  'createdAt': string;
}
export interface o_storyboardGenerationTask {
  'taskUuid': string;
  'shotUuid': string;
  'parentTaskUuid'?: string | null;
  'originDeviceUuid': string;
  'mediaType': "image" | "video";
  'providerId': string;
  'providerTaskId'?: string | null;
  'providerSessionId'?: string | null;
  'mode': string;
  'modelName': string;
  'parametersJson': string;
  'requestDigest': string;
  'status': string;
  'paidBatchConfirmedAt'?: number | null;
  'providerCompletedAt'?: number | null;
  'resultLocatorDigest'?: string | null;
  'progress': number;
  'errorCode'?: string | null;
  'errorSummary'?: string | null;
  'createdAt': number;
  'updatedAt': number;
  'clientOperationId'?: string | null;
  'operationItemIndex'?: number | null;
  'enqueueReady'?: number;
  'projectConcurrencyLimit'?: number | null;
  'modelConcurrencyLimit'?: number | null;
}

export interface o_storyboardGenerationOperation {
  'clientOperationId': string;
  'operationDigest': string;
  'requestIntentDigest': string;
  'itemCount': number;
  'paidBatchConfirmed': number;
  'state': string;
  'createdAt': number;
  'updatedAt': number;
}
export interface o_dreaminaCliSettings {
  'id': number;
  'executablePath'?: string | null;
  'maxConcurrency': number;
  'pollSeconds': number;
  'pauseNewClaims': number;
  'pauseReason': string;
  'enabled': number;
  'updatedAt': number;
}
export interface o_dreaminaCliRuntimeState {
  'id': number;
  'executablePath'?: string | null;
  'preferredExecutionTarget': "windows_native" | "wsl";
  'effectiveExecutionTarget'?: "windows_native" | "wsl" | null;
  'installState': "not_installed" | "installing" | "installed" | "repair_required" | "failed";
  'installVersion'?: string | null;
  'installManaged': number;
  'installCheckedAt'?: number | null;
  'installReason'?: string | null;
  'accountState': "unknown" | "logged_out" | "authorizing" | "logged_in" | "expired" | "failed";
  'accountPoints'?: string | null;
  'accountPlanName'?: string | null;
  'accountExpiresAt'?: string | null;
  'accountRefreshedAt'?: number | null;
  'accountReason'?: string | null;
  'pendingOperation': "none" | "feature_install" | "distribution_install" | "cli_install";
  'updatedAt': number;
}
export interface o_dreaminaCliSession {
  'projectUuid': string;
  'sessionId': string;
  'sessionName': string;
  'cliVersion': string;
  'updatedAt': number;
}
export interface o_dreaminaCliDispatch {
  'taskUuid': string;
  'projectUuid': string;
  'originDeviceUuid': string;
  'mediaType': "image" | "video";
  'providerId': "dreamina-cli";
  'modelName': string;
  'mode': string;
  'projectConcurrencyLimit': number;
  'modelConcurrencyLimit': number;
  'queueState': "queued" | "claiming" | "provider_active" | "postprocessing" | "terminal";
  'providerState': "not_sent" | "running" | "completed" | "failed" | "unknown";
  'providerResultJson'?: string | null;
  'providerTerminalAt'?: number | null;
  'leaseOwner'?: string | null;
  'leaseExpiresAt'?: number | null;
  'slotHeld': number;
  'notificationsMuted': number;
  'createdAt': number;
  'updatedAt': number;
  'clientOperationId'?: string | null;
  'operationItemIndex'?: number | null;
  'dispatchReady'?: number;
  'dispatchIdentityDigest'?: string | null;
}
export interface schema_migrations {
  'applied_at': string;
  'checksum': string;
  'name': string;
  'version'?: number | null;
}

export interface DB {
  "memories": memories;
  "o_agentDeploy": o_agentDeploy;
  "o_agentWorkData": o_agentWorkData;
  "o_artStyle": o_artStyle;
  "o_assets": o_assets;
  "o_assets2Storyboard": o_assets2Storyboard;
  "o_assetsRole2Audio": o_assetsRole2Audio;
  "o_event": o_event;
  "o_eventChapter": o_eventChapter;
  "o_image": o_image;
  "o_imageFlow": o_imageFlow;
  "o_modelPrompt": o_modelPrompt;
  "o_novel": o_novel;
  "o_project": o_project;
  "o_prompt": o_prompt;
  "o_script": o_script;
  "o_scriptAssets": o_scriptAssets;
  "o_setting": o_setting;
  "o_skillAttribution": o_skillAttribution;
  "o_skillList": o_skillList;
  "o_storyboard": o_storyboard;
  "o_storyboardShot": o_storyboardShot;
  "o_storyboardShotAsset": o_storyboardShotAsset;
  "o_storyboardWorkspaceSettings": o_storyboardWorkspaceSettings;
  "o_storyboardCandidate": o_storyboardCandidate;
  "o_storyboardGenerationTask": o_storyboardGenerationTask;
  "o_storyboardGenerationOperation": o_storyboardGenerationOperation;
  "o_dreaminaCliSettings": o_dreaminaCliSettings;
  "o_dreaminaCliRuntimeState": o_dreaminaCliRuntimeState;
  "o_dreaminaCliSession": o_dreaminaCliSession;
  "o_dreaminaCliDispatch": o_dreaminaCliDispatch;
  "o_tasks": o_tasks;
  "o_user": o_user;
  "o_vendorConfig": o_vendorConfig;
  "o_video": o_video;
  "o_videoTrack": o_videoTrack;
  "schema_migrations": schema_migrations;
}

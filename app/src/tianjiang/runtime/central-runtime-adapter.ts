import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import type { CentralAuthGateway, CentralSession } from "../auth/central-session";
import { ProfileConflictError, type ProfileSnapshot } from "../sync/profile-sync";
import {
  PersonalProjectConflictError,
  type PersonalManifest,
  type PersonalRemote,
} from "../sync/personal-project-sync";
import type { TeamRemote } from "../sync/team-project-sync";
import type { CachedOfflineGrant } from "../auth/offline-grant";
import type { PersistedMediaReference } from "../media/model-media-reference";
import { checksumBuffer, checksumFile } from "../sync/checksum";
import { hashFileStreaming } from "../media/project-file-inventory";
import { buildProjectDownloadPlan } from "../sync/project-download-plan";
import { buildAPIPath } from "../contracts";
import type { DownloadedProjectSnapshot } from "./project-runtime-local";
// 中文注释：画布个人同步复用本适配器的 upload session / manifest commit / readback，不另开 OSS 协议。
import { reportSyncProgress, syncProgressStore } from "./sync-progress";
import { createSafeVendorStagingError } from "../storyboard/vendor-generation-safety";

export interface RuntimeProjectCatalogItem {
  projectUuid: string;
  name: string;
  kind: "personal" | "team";
  ownerUserId: number;
  role: "owner" | "editor" | "viewer";
  myRole: "owner" | "editor" | "viewer";
  currentVersion: number;
  syncState: string;
  lastSyncedAt: string | null;
  updatedAt: string;
  lockStatus: "none" | "active" | "expired" | "revoked";
  lockHolderName: string;
  openMode: "editable" | "readonly";
  businessType: "novel" | "script" | "storyboard" | "canvas";
  assetSourceProjectUuid?: string;
  lockId?: string;
  fencingToken?: number;
  lockDeviceUuid?: string;
}

interface ProjectSnapshot extends DownloadedProjectSnapshot {}

interface ProjectRemoteOptions {
  currentVersion: number;
  readObject(
    relativePath: string,
    expected: PersonalManifest["objects"][number],
  ): Buffer | Promise<Buffer>;
  /** 优先用于流式 checksum/分片，避免整项目媒体 Promise.all 进内存。 */
  resolveObjectPath?(
    relativePath: string,
    expected: PersonalManifest["objects"][number],
  ): string | undefined;
  /** 下载盘点专用：只看本地已存在文件，不得走上传捕获集合。 */
  resolveInventoryPath?(relativePath: string): string | undefined;
}

// 中文注释：平台下载授权默认上限为 600 秒；单对象上传授权短时签发，禁止整项目固定 900 秒。
const PROJECT_DATABASE_DOWNLOAD_TTL_SECONDS = 600;
const OBJECT_UPLOAD_AUTH_TTL_SECONDS = 300;
/** 超过该阈值使用 multipart（与服务端 prepare/part/complete 对齐）。 */
const MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024;
/** OSS 非末分片推荐大小（与阈值对齐）。 */
const MULTIPART_PART_SIZE_BYTES = 8 * 1024 * 1024;

/**
 * 本地运行时的中央端适配器。
 * 所有远端业务请求都必须经过 CentralAuthGateway 的路径白名单和令牌注入。
 */
export class CentralRuntimeAdapter {
  /**
   * @deprecated 禁止全局 progressOperationId；请用 runWithSyncProgress / reportSyncProgress。
   */
  private progressOperationId = "";
  /** 最近一次流式下载的 incoming 根目录（测试与安装消费）。 */
  lastDownloadStagingDir?: string;
  /** 账号数据根（incoming 隔离）；未设置时回退 session 侧路径推导。 */
  private dataRootForIncoming?: string;
  private userSegmentForIncoming?: string;

  constructor(
    private readonly gateway: CentralAuthGateway,
    private readonly session: CentralSession,
    readonly deviceUuid: string,
    private readonly objectTransport: typeof fetch = fetch,
  ) {}

  /**
   * @deprecated 仅兼容旧测试；生产入口必须 runWithSyncProgress。
   */
  bindProgress(operationId: string): void {
    this.progressOperationId = operationId;
  }

  /** 绑定账号隔离数据根，下载 incoming 不得落 process.cwd。 */
  bindIncomingStorage(dataRoot: string, userSegment: string): void {
    this.dataRootForIncoming = dataRoot;
    this.userSegmentForIncoming = userSegment;
  }

  private reportProgress(partial: Record<string, unknown>): void {
    // 中文注释：优先 ALS 操作上下文；无上下文时忽略（禁止污染其他 operation）。
    reportSyncProgress(partial as Parameters<typeof reportSyncProgress>[0]);
    // 兼容旧 bindProgress：仅当 ALS 未设置且显式 bind 时写入（生产入口不得依赖）。
    if (this.progressOperationId) {
      syncProgressStore.update({
        operationId: this.progressOperationId,
        ...partial,
      } as { operationId: string });
    }
  }

  async registerDevice(recoveryPublicKey: string, publicFingerprint: string): Promise<void> {
    await this.forward(buildAPIPath("registerDevice"), "POST", {
      deviceUuid: this.deviceUuid,
      name: "天将漫创客户端",
      recoveryPublicKey,
      publicFingerprint,
    });
  }

  async refreshOfflineGrant(): Promise<CachedOfflineGrant> {
    const data = asRecord(await this.forward(buildAPIPath("issueOfflineGrant"), "POST", {
      deviceUuid: this.deviceUuid,
      ttlSeconds: 86_400,
    }));
    const userId = Number(data.userId);
    if (!Number.isSafeInteger(userId) || userId !== this.session.user.id) {
      throw new Error("离线授权用户无效");
    }
    const expiresAt = requiredString(data.expiresAt, "离线授权到期时间");
    if (!Number.isFinite(Date.parse(expiresAt))) throw new Error("离线授权到期时间无效");
    return {
      grantId: requiredUuid(data.grantId, "离线授权 ID"),
      userId,
      deviceUuid: this.deviceUuid,
      expiresAt,
      revokedAt: typeof data.revokedAt === "string" ? data.revokedAt : null,
    };
  }

  profileRemote() {
    return {
      getMetadata: async () => {
        const data = asRecord(await this.forward(buildAPIPath("profileVersionMetadata"), "GET"));
        const version = safeVersion(data.version);
        return {
          version,
          etag: requiredString(data.etag, "个人配置 ETag"),
          updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : undefined,
        };
      },
      getCurrent: async (): Promise<ProfileSnapshot> => {
        const data = asRecord(await this.forward(buildAPIPath("latestProfile"), "GET"));
        const snapshot = asRecord(data.snapshot);
        return {
          version: safeVersion(data.version),
          entries: asRecord(snapshot.entries ?? data.entries) as ProfileSnapshot["entries"],
        };
      },
      commit: async (baseVersion: number, entries: ProfileSnapshot["entries"]): Promise<ProfileSnapshot> => {
        try {
          const data = asRecord(await this.forward(buildAPIPath("commitProfile"), "POST", {
            baseVersion,
            snapshot: { schemaVersion: 1, entries },
          }));
          const snapshot = asRecord(data.snapshot);
          return {
            version: safeVersion(data.version),
            entries: asRecord(snapshot.entries ?? data.entries) as ProfileSnapshot["entries"],
          };
        } catch (error) {
          if (error instanceof Error && error.message.includes("基础版本")) throw new ProfileConflictError();
          throw error;
        }
      },
    };
  }

  async projectCatalog(currentUserId: number): Promise<RuntimeProjectCatalogItem[]> {
    const data = asRecord(await this.forward(buildAPIPath("projectCatalog"), "GET"));
    const projects = data.projects;
    if (!Array.isArray(projects)) throw new Error("中央项目目录无效");
    return projects.map((item) => {
      const row = asRecord(item);
      if (row.kind !== "personal" && row.kind !== "team") throw new Error("中央项目类型无效");
      // Gin 目录使用 myRole；兼容旧中央存根的 role，但对未知角色继续失败关闭。
      const role = row.myRole ?? row.role;
      if (role !== "owner" && role !== "editor" && role !== "viewer") {
        throw new Error("中央项目角色无效");
      }
      const ownerUserId = Number(row.ownerUserId);
      // 团队项目由团队实体持有，中央服务以 0 表示没有个人所有者；个人项目仍必须有有效用户 ID。
      if (
        !Number.isSafeInteger(ownerUserId)
        || ownerUserId < 0
        || (row.kind === "personal" && ownerUserId === 0)
      ) {
        throw new Error("中央项目所有者无效");
      }
      if (row.kind === "personal" && ownerUserId !== currentUserId) {
        throw new Error("个人项目所有者与当前用户不匹配");
      }
      if (
        row.businessType !== "novel"
        && row.businessType !== "script"
        && row.businessType !== "storyboard"
        && row.businessType !== "canvas"
      ) {
        const error = new Error("项目业务类型无效") as Error & { errorCode: string };
        error.errorCode = "PROJECT_BUSINESS_TYPE_INVALID";
        throw error;
      }
      if (row.businessType === "canvas" && row.kind === "team") {
        const error = new Error("无限画布首期不支持团队归属") as Error & { errorCode: string };
        error.errorCode = "CANVAS_TEAM_SCOPE_NOT_SUPPORTED";
        throw error;
      }
      const lockStatus = (
        row.lockStatus === "active"
        || row.lockStatus === "expired"
        || row.lockStatus === "revoked"
      ) ? row.lockStatus : "none";
      const openMode = row.openMode === "readonly" || row.openMode === "editable"
        ? row.openMode
        : role === "viewer" ? "readonly" : "editable";
      return {
        projectUuid: requiredUuid(row.projectUuid, "项目 UUID"),
        name: requiredString(row.name, "项目名称"),
        kind: row.kind,
        ownerUserId,
        role,
        myRole: role,
        currentVersion: safeVersion(row.currentVersion),
        syncState: typeof row.syncState === "string"
          ? row.syncState
          : role === "viewer" ? "readonly" : "synced",
        lastSyncedAt: typeof row.lastSyncedAt === "string" ? row.lastSyncedAt : null,
        updatedAt: typeof row.updatedAt === "string"
          ? row.updatedAt
          : typeof row.lastSyncedAt === "string" ? row.lastSyncedAt : "",
        lockStatus,
        lockHolderName: typeof row.lockHolderName === "string" ? row.lockHolderName : "",
        openMode,
        businessType: row.businessType,
        assetSourceProjectUuid: typeof row.assetSourceProjectUuid === "string"
          ? row.assetSourceProjectUuid
          : "",
      };
    });
  }

  async signObjectDownload(objectKey: string, expiresSeconds: number): Promise<string> {
    const target = parseStableObjectKey(objectKey);
    const data = asRecord(await this.forward(buildAPIPath("objectAuthorization"), "POST", {
      method: "GET",
      projectUuid: target.projectUuid,
      version: target.version,
      relativePath: target.relativePath,
      deviceUuid: this.deviceUuid,
      expiresInSeconds: expiresSeconds,
      useCdn: false,
    }));
    const signedUrl = requiredString(data.url, "对象短签 URL");
    const parsed = new URL(signedUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("中央对象短签 URL 无效");
    }
    return signedUrl;
  }

  async stageModelMedia(
    projectUuid: string,
    baseVersion: number,
    reference: PersistedMediaReference,
    bytes: Buffer,
    expiresSeconds: number,
    guard: { lockId?: string; fencingToken?: number } = {},
  ): Promise<string> {
    if (!reference.relativePath || reference.objectKey) {
      throw new Error("本地媒体暂存引用无效");
    }
    const checksum = checksumBuffer(bytes);
    if (
      checksum.size !== reference.size
      || checksum.md5 !== reference.md5.toLowerCase()
    ) {
      throw new Error("本地媒体内容与持久元数据不一致");
    }
    let begun;
    try {
      begun = asRecord(await this.forward(
        buildAPIPath("createUploadSession", {
          project_uuid: requiredUuid(projectUuid, "项目 UUID"),
        }),
        "POST",
        {
          baseVersion: safeVersion(baseVersion),
          ttlSeconds: Math.min(3600, Math.max(300, expiresSeconds + 120)),
          deviceUuid: this.deviceUuid,
          lockId: guard.lockId ?? "",
          fencingToken: guard.fencingToken ?? 0,
          objects: [{
            relativePath: reference.relativePath,
            size: checksum.size,
            md5: checksum.md5,
            crc64: checksum.crc64,
            uploadMode: "simple",
          }],
        },
      ));
    } catch (error) {
      if (error instanceof Error && error.name === "VendorGenerationPhaseError") throw error;
      throw createSafeVendorStagingError("upload_session");
    }
    const sessionUuid = requiredUuid(
      begun.sessionUuid ?? begun.uploadSessionId,
      "媒体暂存会话 ID",
    );
    const contentMD5 = Buffer.from(checksum.md5, "hex").toString("base64");
    let upload;
    try {
      upload = asRecord(await this.forward(buildAPIPath("objectAuthorization"), "POST", {
        method: "PUT",
        sessionUuid,
        deviceUuid: this.deviceUuid,
        relativePath: reference.relativePath,
        uploadMode: "simple",
        contentMd5: contentMD5,
        expiresInSeconds: Math.min(900, Math.max(60, expiresSeconds)),
        useCdn: false,
      }));
    } catch (error) {
      if (error instanceof Error && error.name === "VendorGenerationPhaseError") throw error;
      throw createSafeVendorStagingError("sign_url");
    }
    const uploadURL = requiredHTTPSURL(upload.url, "媒体暂存上传 URL");
    const signedHeaders = buildObjectUploadHeaders(
      asStringRecord(upload.signedHeaders),
      contentMD5,
    );
    let uploaded;
    try {
      uploaded = await this.objectTransport(uploadURL, {
        method: "PUT",
        // 媒体与项目快照使用同一 V4 签名头契约，禁止重复追加 Content-MD5。
        headers: signedHeaders,
        body: Uint8Array.from(bytes).buffer,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "VendorGenerationPhaseError") throw error;
      throw createSafeVendorStagingError("oss_put");
    }
    if (!uploaded.ok) {
      throw createSafeVendorStagingError("oss_put");
    }
    try {
      await this.forward(buildAPIPath("confirmUploadObject", { session_uuid: sessionUuid }), "POST", {
        relativePath: reference.relativePath,
        deviceUuid: this.deviceUuid,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "VendorGenerationPhaseError") throw error;
      throw createSafeVendorStagingError("confirm");
    }
    let download;
    try {
      download = asRecord(await this.forward(buildAPIPath("objectAuthorization"), "POST", {
        method: "GET",
        sessionUuid,
        deviceUuid: this.deviceUuid,
        relativePath: reference.relativePath,
        expiresInSeconds: expiresSeconds,
        useCdn: false,
      }));
    } catch (error) {
      if (error instanceof Error && error.name === "VendorGenerationPhaseError") throw error;
      throw createSafeVendorStagingError("sign_url");
    }
    return requiredHTTPSURL(download.url, "媒体暂存下载 URL");
  }

  personalRemote(
    projectUuid: string,
    onDownloaded: (snapshot: ProjectSnapshot) => void,
    options: ProjectRemoteOptions,
  ): PersonalRemote {
    let knownVersion = safeVersion(options.currentVersion);
    return {
      latest: async () => {
        // 中央项目刚创建时还没有已发布版本；此时本机应建立首份空项目，不能请求不存在的 latest。
        if (knownVersion === 0) {
          const empty = { version: 0, objects: [], records: {} } satisfies ProjectSnapshot;
          onDownloaded(empty);
          return { version: 0, objects: [] };
        }
        const snapshot = await this.readProjectManifest(projectUuid);
        knownVersion = snapshot.version;
        onDownloaded(snapshot);
        return { version: snapshot.version, objects: snapshot.objects };
      },
      downloadObjects: async (manifest, requiredObjects) => {
        const snapshot = await this.downloadProject(
          projectUuid,
          requiredObjects,
          {
            version: manifest.version,
            objects: manifest.objects,
            records: {},
          },
        );
        knownVersion = snapshot.version || manifest.version;
        onDownloaded({ ...snapshot, version: manifest.version, objects: manifest.objects });
      },
      publish: async (baseVersion, next, _changedPaths, _reason) => {
        try {
          const committedVersion = await this.publishProject(projectUuid, baseVersion, next, {
            readObject: options.readObject,
            resolveObjectPath: options.resolveObjectPath,
          });
          knownVersion = committedVersion;
          return { ...next, version: committedVersion };
        } catch (error) {
          if (error instanceof Error && error.message.includes("基础版本")) {
            throw new PersonalProjectConflictError();
          }
          throw error;
        }
      },
    };
  }

  teamRemote(
    projectUuid: string,
    onDownloaded: (snapshot: ProjectSnapshot) => void,
    options: ProjectRemoteOptions,
  ): TeamRemote {
    let knownVersion = safeVersion(options.currentVersion);
    return {
      acquire: async () => {
        const data = asRecord(await this.forward(
          buildAPIPath("acquireLock", { project_uuid: projectUuid }),
          "POST",
          { deviceUuid: this.deviceUuid },
        ));
        return {
          lockId: requiredString(data.lockId ?? data.lockUuid, "锁 ID"),
          fencingToken: safeVersion(data.fencingToken),
          holderName: typeof data.holderName === "string" ? data.holderName : undefined,
        };
      },
      download: async () => {
        if (knownVersion === 0) {
          onDownloaded({ version: 0, objects: [], records: {} });
          return;
        }
        const snapshot = await this.readProjectManifest(projectUuid);
        // 中文注释：打开路径只允许盘点已存在文件；缺少入口时禁止把全部对象当成缺失并重复下载。
        if (typeof options.resolveInventoryPath !== "function") {
          throw Object.assign(new Error("项目下载缺少本地盘点入口"), {
            code: "PROJECT_DOWNLOAD_INVENTORY_RESOLVER_MISSING",
          });
        }
        const localDigests = [];
        for (const object of snapshot.objects) {
          const absolute = options.resolveInventoryPath(object.relativePath);
          if (!absolute || !fs.existsSync(absolute)) continue;
          const relativeParts = object.relativePath.split("/");
          const projectRoot = path.resolve(absolute, ...relativeParts.map(() => ".."));
          // 中文注释：项目媒体盘点必须把真实路径锁在推导出的 files 根内；数据库仍走通用文件合同。
          const digest = hashFileStreaming(absolute, object.relativePath.startsWith("files/")
            ? { filesRoot: path.join(projectRoot, "files") }
            : undefined);
          localDigests.push({
            relativePath: object.relativePath,
            size: digest.size,
            md5: digest.md5,
          });
        }
        const plan = buildProjectDownloadPlan(localDigests, snapshot.objects.map((item) => ({
          relativePath: item.relativePath,
          size: item.size ?? 0,
          md5: item.md5,
        })), snapshot.version);
        // 中文注释：复用本轮已读 manifest，禁止变化对象下载再 GET 一次项目清单。
        const downloaded = plan.requiredObjects.length === 0
          ? { ...snapshot, objectContents: {}, stagingFiles: {}, incomingRoot: undefined }
          : await this.downloadProject(projectUuid, plan.requiredObjects, snapshot);
        knownVersion = downloaded.version;
        onDownloaded(downloaded);
      },
      publish: async (lockId, fencingToken, snapshot) => {
        knownVersion = await this.publishProject(projectUuid, snapshot.version, snapshot, {
          readObject: options.readObject,
          resolveObjectPath: options.resolveObjectPath,
          lockId,
          fencingToken,
        });
      },
      release: async (lockId, fencingToken) => {
        await this.forward(buildAPIPath("releaseLock", { project_uuid: projectUuid }), "DELETE", {
          deviceUuid: this.deviceUuid,
          lockId,
          fencingToken,
          reason: "project_closed",
        });
      },
      heartbeat: async (lockId, fencingToken) => {
        await this.forward(buildAPIPath("heartbeatLock", { project_uuid: projectUuid }), "POST", {
          deviceUuid: this.deviceUuid,
          lockId,
          fencingToken,
        });
      },
      // 中文注释：必须请求中央 getProject 权威版本，禁止返回 catalog 缓存 knownVersion
      latestVersion: async () => {
        const snapshot = await this.readProjectManifest(projectUuid);
        knownVersion = snapshot.version;
        if (!Number.isFinite(knownVersion)) {
          throw new Error("中央项目版本非有限值");
        }
        return knownVersion;
      },
      // 中文注释：版本+对象摘要双证据，供 publishing 崩溃恢复
      fetchProjectEvidence: async () => {
        const snapshot = await this.readProjectManifest(projectUuid);
        knownVersion = snapshot.version;
        if (!Number.isFinite(knownVersion)) {
          throw new Error("中央项目版本非有限值");
        }
        return {
          version: knownVersion,
          objects: snapshot.objects.map((o) => ({
            relativePath: o.relativePath,
            md5: o.md5,
            size: o.size,
          })),
        };
      },
    };
  }

  private async downloadProject(
    projectUuid: string,
    requiredObjects?: Array<{ relativePath: string; size?: number; md5: string }>,
    knownSnapshot?: ProjectSnapshot,
  ): Promise<ProjectSnapshot> {
    const snapshot = knownSnapshot ?? await this.readProjectManifest(projectUuid);
    if (snapshot.version === 0) {
      return { ...snapshot, objectContents: {}, stagingFiles: {}, incomingRoot: undefined };
    }

    const database = snapshot.objects.find((item) => item.relativePath === "project.sqlite");
    if (!database) throw new Error("中央项目快照缺少 project.sqlite");
    const wanted = requiredObjects && requiredObjects.length > 0
      ? snapshot.objects.filter((object) => requiredObjects.some((item) => item.relativePath === object.relativePath))
      : snapshot.objects;
    if (wanted.length === 0) {
      return { ...snapshot, objectContents: {}, stagingFiles: {}, incomingRoot: undefined };
    }

    // 中文注释：incoming 位于账号/项目隔离数据根；禁止 process.cwd 作为生产权威位置。
    const stagingRoot = this.resolveIncomingOperationDir(projectUuid);
    fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    this.lastDownloadStagingDir = stagingRoot;
    const stagingFiles: Record<string, string> = {};
    const totalBytes = wanted.reduce((sum, o) => sum + (o.size ?? 0), 0);
    let downloadedBytes = 0;
    let downloadOk = false;
    this.reportProgress({
      phase: "downloading",
      resetTransferCounters: true,
      completedObjects: 0,
      objectIndex: 0,
      totalObjects: wanted.length,
      objectTotal: wanted.length,
      totalBytes,
      counts: countMediaKinds(wanted),
    });

    try {
      let index = 0;
      for (const object of wanted) {
        index += 1;
        const authorization = asRecord(await this.forward(buildAPIPath("objectAuthorization"), "POST", {
          method: "GET",
          projectUuid,
          version: snapshot.version,
          relativePath: object.relativePath,
          deviceUuid: this.deviceUuid,
          expiresInSeconds: PROJECT_DATABASE_DOWNLOAD_TTL_SECONDS,
          useCdn: false,
        }));
        const downloadURL = requiredObjectTransferURL(
          authorization.url,
          "项目对象下载 URL",
          this.session.serverUrl,
        );
        const downloaded = await this.objectTransport(downloadURL, { method: "GET" });
        if (!downloaded.ok) {
          throw new ObjectDownloadHTTPError(
            downloaded.status,
            downloaded.headers.get("x-oss-request-id") ?? downloaded.headers.get("x-request-id"),
          );
        }
        const target = path.join(stagingRoot, ...object.relativePath.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const { size, md5 } = await streamResponseToFile(downloaded, target);
        if (size !== object.size || md5 !== object.md5.toLowerCase()) {
          throw Object.assign(new Error("项目对象下载内容与中央清单不一致"), {
            code: "PROJECT_DOWNLOAD_CHECKSUM_MISMATCH",
          });
        }
        stagingFiles[object.relativePath] = target;
        downloadedBytes += size;
        this.reportProgress({
          phase: "downloading",
          completedObjects: index,
          objectIndex: index,
          uploadedBytes: downloadedBytes,
          totalBytes,
        });
      }
      downloadOk = true;
      return {
        ...snapshot,
        objectContents: {},
        stagingFiles,
        incomingRoot: stagingRoot,
        stagingRoot,
      };
    } catch (error) {
      this.reportProgress({
        phase: "failed",
        failedObject: error instanceof Error ? error.message : "download failed",
      });
      throw error;
    } finally {
      // 中文注释：失败路径立即删 operation 目录；成功路径保留给 install，install finally 再删。
      if (!downloadOk) {
        safeRemoveIncomingDir(stagingRoot, this.incomingRootBase(projectUuid));
      }
    }
  }

  private incomingRootBase(projectUuid: string): string {
    if (this.dataRootForIncoming && this.userSegmentForIncoming) {
      return path.resolve(
        this.dataRootForIncoming,
        "runtime-users",
        this.userSegmentForIncoming,
        "incoming-downloads",
        projectUuid,
      );
    }
    // 测试夹具未 bind 时：仍优先账号无关但可定位的 tmp，避免 cwd 权威
    return path.resolve(process.cwd(), ".tmp", "incoming-downloads", projectUuid);
  }

  private resolveIncomingOperationDir(projectUuid: string): string {
    const base = this.incomingRootBase(projectUuid);
    const op = path.resolve(base, `${process.pid}-${crypto.randomUUID()}`);
    if (!op.startsWith(base + path.sep) && op !== base) {
      throw new Error("incoming 下载目录越界");
    }
    return op;
  }

  /** 仅读中央版本与对象摘要；锁恢复证据路径不得顺带下载整个数据库。 */
  private async readProjectManifest(projectUuid: string): Promise<ProjectSnapshot> {
    const data = asRecord(await this.forward(buildAPIPath("getProject", {
      project_uuid: projectUuid,
    }), "GET"));
    const objects = Array.isArray(data.objects) ? data.objects.map((value) => {
      const item = asRecord(value);
      const size = Number(item.size);
      const md5 = requiredString(item.md5, "项目对象摘要").toLowerCase();
      if (!/^[a-f0-9]{32}$/.test(md5)) throw new Error("项目对象摘要无效");
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("项目对象大小无效");
      const relativePath = requiredString(item.relativePath, "项目对象路径");
      const rawMediaType = typeof item.mediaType === "string"
        ? item.mediaType
        : typeof item.media_type === "string"
          ? item.media_type
          : undefined;
      const mediaType: PersonalManifest["objects"][number]["mediaType"] | undefined =
        rawMediaType === "image" || rawMediaType === "video" || rawMediaType === "audio"
          || rawMediaType === "text" || rawMediaType === "binary"
          ? rawMediaType
          : relativePath !== "project.sqlite"
            ? mediaTypeForPath(relativePath)
            : undefined;
      return {
        relativePath,
        md5,
        size,
        ...(mediaType ? { mediaType } : {}),
      };
    }) : [];
    return {
      version: safeVersion(data.version ?? data.currentVersion),
      objects,
      records: asRecord(data.records),
      objectContents: {},
    };
  }

  private async publishProject(
    projectUuid: string,
    baseVersion: number,
    next: PersonalManifest,
    options: {
      readObject: ProjectRemoteOptions["readObject"];
      resolveObjectPath?: ProjectRemoteOptions["resolveObjectPath"];
      lockId?: string;
      fencingToken?: number;
    },
  ): Promise<number> {
    if (next.objects.length === 0) throw new Error("项目同步快照为空");
    const databaseMeta = next.objects.find((item) => item.relativePath === "project.sqlite");
    if (!databaseMeta) throw new Error("项目同步快照缺少 project.sqlite");

    const totalCandidateBytes = next.objects.reduce((sum, o) => sum + (o.size ?? 0), 0);
    this.reportProgress({
      phase: "snapshotting",
      totalObjects: next.objects.length,
      objectTotal: next.objects.length,
      totalBytes: totalCandidateBytes,
      counts: countMediaKinds(next.objects),
    });

    // 中文注释：完整候选清单顺序校验摘要；禁止 Promise.all 把全部媒体读入内存。
    type Planned = {
      object: PersonalManifest["objects"][number];
      size: number;
      md5: string;
      crc64: string;
      uploadMode: "simple" | "multipart";
      absolutePath?: string;
    };
    const planned: Planned[] = [];
    for (const object of next.objects) {
      const absolutePath = options.resolveObjectPath?.(object.relativePath, object);
      let size: number;
      let md5: string;
      let crc64: string;
      if (absolutePath && fs.existsSync(absolutePath)) {
        const checksum = await checksumFile(absolutePath, { crc64: true });
        size = checksum.size;
        md5 = checksum.md5;
        crc64 = checksum.crc64 ?? "0";
      } else {
        // 回退：单对象读入（仍禁止对全量 Promise.all）
        const bytes = Buffer.from(await options.readObject(object.relativePath, object));
        const checksum = checksumBuffer(bytes);
        size = checksum.size;
        md5 = checksum.md5;
        crc64 = checksum.crc64;
      }
      if (
        md5 !== object.md5.toLowerCase()
        || (object.size !== undefined && size !== object.size)
      ) {
        throw new Error(`项目同步对象校验失败：${object.relativePath}`);
      }
      planned.push({
        object,
        size,
        md5,
        crc64,
        uploadMode: size >= MULTIPART_THRESHOLD_BYTES ? "multipart" : "simple",
        absolutePath,
      });
    }

    this.reportProgress({ phase: "validating", totalObjects: planned.length });

    const begun = asRecord(await this.forward(buildAPIPath("createUploadSession", {
      project_uuid: projectUuid,
    }), "POST", {
      baseVersion,
      // 中文注释：会话 TTL 仅覆盖编排；对象上传授权按对象短时刷新，禁止整项目固定 900 秒。
      ttlSeconds: 3600,
      deviceUuid: this.deviceUuid,
      ...(options.lockId ? { lockId: options.lockId } : {}),
      ...(options.fencingToken !== undefined ? { fencingToken: options.fencingToken } : {}),
      objects: planned.map((item) => ({
        relativePath: item.object.relativePath,
        size: item.size,
        md5: item.md5,
        crc64: item.crc64,
        uploadMode: item.uploadMode,
      })),
    }));
    const uploadSessionId = requiredUuid(
      begun.uploadSessionId ?? begun.sessionUuid,
      "上传会话 ID",
    );

    // 中文注释：中央权威增量——只上传 session 返回的 required 对象；未变化对象复用。
    const sessionObjects = Array.isArray(begun.objects)
      ? begun.objects.map((value) => {
        const row = asRecord(value);
        return requiredString(row.relativePath, "上传对象路径");
      })
      : [];
    const requiredFromField = Array.isArray(begun.requiredUploadObjects)
      ? begun.requiredUploadObjects.map((value) => String(value))
      : sessionObjects;
    const requiredPaths = new Set(requiredFromField);
    const requiredPlanned = planned.filter((item) => requiredPaths.has(item.object.relativePath));
    const uploadTotalBytes = requiredPlanned.reduce((sum, item) => sum + item.size, 0);
    let completedObjects = 0;
    let uploadedBytes = 0;
    this.reportProgress({
      phase: "uploading",
      resetTransferCounters: true,
      totalObjects: requiredPlanned.length,
      objectTotal: requiredPlanned.length,
      completedObjects: 0,
      uploadedBytes: 0,
      totalBytes: uploadTotalBytes,
      counts: countMediaKinds(requiredPlanned.map((item) => item.object)),
    });

    try {
      for (const item of requiredPlanned) {
        if (item.uploadMode === "multipart") {
          await this.uploadObjectMultipart(uploadSessionId, item);
        } else {
          await this.uploadObjectSimple(uploadSessionId, item, options.readObject);
        }
        completedObjects += 1;
        uploadedBytes += item.size;
        this.reportProgress({
          phase: "uploading",
          completedObjects,
          objectIndex: completedObjects,
          objectTotal: requiredPlanned.length,
          uploadedBytes,
          totalBytes: uploadTotalBytes,
        });
      }

      this.reportProgress({ phase: "committing" });
      const databasePlanned = planned.find((item) => item.object.relativePath === "project.sqlite")!;
      const committed = asRecord(await this.forward(
        buildAPIPath("commitVersion", { session_uuid: uploadSessionId }),
        "POST",
        {
          deviceUuid: this.deviceUuid,
          ...(options.lockId ? { lockId: options.lockId } : {}),
          ...(options.fencingToken !== undefined ? { fencingToken: options.fencingToken } : {}),
          manifest: {
            schema_version: 1,
            project_uuid: projectUuid,
            version: baseVersion + 1,
            base_version: baseVersion,
            created_at: new Date().toISOString(),
            database: {
              relative_path: databasePlanned.object.relativePath,
              size: databasePlanned.size,
              md5: databasePlanned.md5,
            },
            // 中文注释：完整清单仍引用未上传复用对象，删除通过不再引用表达。
            files: planned
              .filter((item) => item.object.relativePath !== "project.sqlite")
              .map((item) => ({
                relative_path: item.object.relativePath,
                size: item.size,
                md5: item.md5,
                media_type: mediaTypeForPath(item.object.relativePath),
              })),
          },
        },
      ));
      this.reportProgress({ phase: "finalizing", completedObjects, uploadedBytes });
      return safeVersion(committed.version);
    } catch (error) {
      this.reportProgress({
        phase: "failed",
        failedObject: error instanceof Error ? error.message : "upload failed",
      });
      // 暂存会话已建立后失败必须显式终止；终止失败不能覆盖原始同步错误。
      try {
        await this.forward(buildAPIPath("failUploadSession", { session_uuid: uploadSessionId }), "POST", {
          failureCode: error instanceof ObjectUploadHTTPError
            ? `client_upload_http_${error.status}`
            : "client_upload_failed",
        });
      } catch {
        // 原始错误更能说明退出阻断原因，补偿请求仅做尽力而为。
      }
      throw error;
    }
  }

  private async uploadObjectSimple(
    uploadSessionId: string,
    item: {
      object: PersonalManifest["objects"][number];
      size: number;
      md5: string;
      absolutePath?: string;
    },
    readObject: ProjectRemoteOptions["readObject"],
  ): Promise<void> {
    const bytes = item.absolutePath && fs.existsSync(item.absolutePath)
      ? fs.readFileSync(item.absolutePath)
      : Buffer.from(await readObject(item.object.relativePath, item.object));
    if (bytes.length !== item.size) {
      throw new Error(`项目同步对象大小变化：${item.object.relativePath}`);
    }
    const contentMD5 = Buffer.from(item.md5, "hex").toString("base64");
    const authorization = asRecord(await this.forward(buildAPIPath("objectAuthorization"), "POST", {
      method: "PUT",
      sessionUuid: uploadSessionId,
      deviceUuid: this.deviceUuid,
      relativePath: item.object.relativePath,
      uploadMode: "simple",
      contentMd5: contentMD5,
      expiresInSeconds: OBJECT_UPLOAD_AUTH_TTL_SECONDS,
      useCdn: false,
    }));
    const uploadURL = requiredObjectTransferURL(
      authorization.url,
      "项目对象上传 URL",
      this.session.serverUrl,
    );
    const uploadHeaders = buildObjectUploadHeaders(
      asStringRecord(authorization.signedHeaders),
      contentMD5,
    );
    const uploaded = await this.objectTransport(uploadURL, {
      method: "PUT",
      headers: uploadHeaders,
      body: Uint8Array.from(bytes).buffer,
    });
    if (!uploaded.ok) {
      throw new ObjectUploadHTTPError(
        uploaded.status,
        uploaded.headers.get("x-oss-request-id") ?? uploaded.headers.get("x-request-id"),
      );
    }
    await this.forward(buildAPIPath("confirmUploadObject", { session_uuid: uploadSessionId }), "POST", {
      relativePath: item.object.relativePath,
      deviceUuid: this.deviceUuid,
    });
  }

  private async uploadObjectMultipart(
    uploadSessionId: string,
    item: {
      object: PersonalManifest["objects"][number];
      size: number;
      md5: string;
      absolutePath?: string;
    },
  ): Promise<void> {
    if (!item.absolutePath || !fs.existsSync(item.absolutePath)) {
      throw new Error(`大文件 multipart 缺少本地路径：${item.object.relativePath}`);
    }
    // 中文注释：prepare → 按分片短时授权 PUT → complete（complete 内 confirm）。
    const prepared = asRecord(await this.forward(
      multipartSessionPath(uploadSessionId, "prepare"),
      "POST",
      {
        relativePath: item.object.relativePath,
        deviceUuid: this.deviceUuid,
      },
    ));
    const uploadId = requiredString(prepared.uploadId ?? prepared.uploadID, "分片上传 ID");
    const parts: Array<{ partNumber: number; etag: string }> = [];
    const fd = fs.openSync(item.absolutePath, "r");
    try {
      let offset = 0;
      let partNumber = 1;
      while (offset < item.size) {
        const length = Math.min(MULTIPART_PART_SIZE_BYTES, item.size - offset);
        const chunk = Buffer.alloc(length);
        const read = fs.readSync(fd, chunk, 0, length, offset);
        if (read !== length) throw new Error(`读取分片失败：${item.object.relativePath}`);
        const contentMD5 = crypto.createHash("md5").update(chunk).digest("base64");
        const authorization = asRecord(await this.forward(buildAPIPath("objectAuthorization"), "POST", {
          method: "PUT",
          sessionUuid: uploadSessionId,
          deviceUuid: this.deviceUuid,
          relativePath: item.object.relativePath,
          uploadMode: "multipart",
          uploadId,
          partNumber,
          contentMd5: contentMD5,
          expiresInSeconds: OBJECT_UPLOAD_AUTH_TTL_SECONDS,
          useCdn: false,
        }));
        const uploadURL = requiredObjectTransferURL(
          authorization.url,
          "项目分片上传 URL",
          this.session.serverUrl,
        );
        const uploadHeaders = buildObjectUploadHeaders(
          asStringRecord(authorization.signedHeaders),
          contentMD5,
        );
        const uploaded = await this.objectTransport(uploadURL, {
          method: "PUT",
          headers: uploadHeaders,
          body: Uint8Array.from(chunk).buffer,
        });
        if (!uploaded.ok) {
          throw new ObjectUploadHTTPError(
            uploaded.status,
            uploaded.headers.get("x-oss-request-id") ?? uploaded.headers.get("x-request-id"),
          );
        }
        const etag = uploaded.headers.get("etag")
          ?? uploaded.headers.get("ETag")
          ?? `"${crypto.createHash("md5").update(chunk).digest("hex")}"`;
        parts.push({ partNumber, etag: etag.replaceAll('"', "") });
        offset += length;
        partNumber += 1;
      }
    } finally {
      fs.closeSync(fd);
    }
    await this.forward(
      multipartSessionPath(uploadSessionId, "complete"),
      "POST",
      {
        relativePath: item.object.relativePath,
        deviceUuid: this.deviceUuid,
        parts: parts.map((part) => ({
          partNumber: part.partNumber,
          etag: part.etag,
        })),
      },
    );
  }

  private forward(pathname: string, method: string, body?: unknown): Promise<unknown> {
    return this.gateway.forwardBusinessRequest(this.session, pathname, method, body);
  }
}

/** OSS PUT 的安全结构化错误；仅保留 HTTP 状态与脱敏 RequestId。 */
export class ObjectUploadHTTPError extends Error {
  readonly code: string;
  readonly requestId: string;

  constructor(
    readonly status: number,
    requestId: string | null,
    messagePrefix = "项目对象上传失败",
  ) {
    super(`${messagePrefix}（HTTP ${status}）`);
    this.name = "ObjectUploadHTTPError";
    this.code = `HTTP_${status}`;
    this.requestId = sanitizeObjectRequestId(requestId);
  }
}

/** OSS GET 的结构化错误；不携带签名 URL 或响应正文。 */
export class ObjectDownloadHTTPError extends Error {
  readonly code: string;
  readonly requestId: string;

  constructor(readonly status: number, requestId: string | null) {
    super(`项目对象下载失败（HTTP ${status}）`);
    this.name = "ObjectDownloadHTTPError";
    this.code = `HTTP_${status}`;
    this.requestId = sanitizeObjectRequestId(requestId);
  }
}

/**
 * 把签名头按 HTTP 大小写无关语义折叠成唯一键。
 * Content-MD5 是 V4 签名的一部分，缺失或与本地摘要不一致都必须失败关闭。
 */
export function buildObjectUploadHeaders(
  signedHeaders: Record<string, string>,
  expectedContentMD5: string,
): Record<string, string> {
  const normalized = new Map<string, string>();
  for (const [rawName, rawValue] of Object.entries(signedHeaders)) {
    const name = rawName.trim().toLowerCase();
    const value = rawValue.trim();
    if (!name || !value) throw new Error("项目对象签名头无效");
    const previous = normalized.get(name);
    if (previous !== undefined && previous !== value) {
      throw new Error("项目对象签名头重复且内容不一致");
    }
    normalized.set(name, value);
  }
  const signedMD5 = normalized.get("content-md5");
  if (!signedMD5 || signedMD5 !== expectedContentMD5) {
    throw Object.assign(new Error("项目对象 Content-MD5 签名头缺失或不一致"), {
      code: "UPLOAD_SIGNED_HEADER_INVALID",
    });
  }
  return Object.fromEntries(normalized.entries());
}

function sanitizeObjectRequestId(value: string | null): string {
  const trimmed = value?.trim() ?? "";
  return /^[A-Za-z0-9_-]{1,64}$/.test(trimmed) ? trimmed : "";
}

function parseStableObjectKey(objectKey: string): {
  projectUuid: string;
  version: number;
  relativePath: string;
} {
  const match = /^v1\/projects\/([0-9a-f-]{36})\/([1-9][0-9]*)\/(.+)$/i.exec(objectKey);
  if (!match) throw new Error("平台稳定对象键无效");
  const projectUuid = requiredUuid(match[1], "稳定对象项目 UUID");
  const version = Number(match[2]);
  const relativePath = match[3];
  if (
    !Number.isSafeInteger(version)
    || relativePath.startsWith("/")
    || relativePath.includes("\\")
    || relativePath.includes(":")
    || relativePath.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("平台稳定对象键无效");
  }
  return { projectUuid, version, relativePath };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}无效`);
  return value;
}

function asStringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
}

function requiredHTTPSURL(value: unknown, label: string): string {
  const text = requiredString(value, label);
  const parsed = new URL(text);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${label}无效`);
  }
  return text;
}

function requiredUuid(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new Error(`${label}无效`);
  }
  return text;
}

function safeVersion(value: unknown): number {
  const version = Number(value ?? 0);
  if (!Number.isSafeInteger(version) || version < 0) throw new Error("中央版本无效");
  return version;
}

function requiredObjectTransferURL(value: unknown, label: string, centralServerUrl: string): string {
  const text = requiredString(value, label);
  const parsed = new URL(text);
  if (parsed.username || parsed.password) throw new Error(`${label}无效`);
  if (parsed.protocol === "https:") return text;

  const central = new URL(centralServerUrl);
  // 仅正式验收夹具可让同源 127.0.0.1 代替 OSS；生产环境仍强制 HTTPS。
  if (
    process.env.TIANJIANG_ACCEPTANCE_MODE === "1"
    && parsed.protocol === "http:"
    && parsed.hostname === "127.0.0.1"
    && parsed.origin === central.origin
  ) {
    return text;
  }
  throw new Error(`${label}无效`);
}

/** 业务鉴权 v1 multipart 路径（控制面白名单 + 中央 router 已注册）。 */
function multipartSessionPath(sessionUuid: string, action: "prepare" | "complete"): string {
  return `/api/tianjiang/v1/upload-sessions/${encodeURIComponent(sessionUuid)}/multipart/${action}`;
}

/** 删除前必须验证绝对路径位于预期 incoming 根内。 */
export function safeRemoveIncomingDir(target: string, allowedRoot: string): void {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(allowedRoot);
  if (
    resolvedTarget !== resolvedRoot
    && !resolvedTarget.startsWith(resolvedRoot + path.sep)
  ) {
    return;
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
}

/**
 * 启动时清理过期 orphan incoming；不删活跃/越界目录。
 * @returns 删除的 operation 目录数
 */
export function sweepExpiredIncomingDownloads(
  dataRoot: string,
  options: { maxAgeMs?: number } = {},
): number {
  const maxAgeMs = options.maxAgeMs ?? 24 * 3600 * 1000;
  const usersRoot = path.resolve(dataRoot, "runtime-users");
  if (!fs.existsSync(usersRoot)) return 0;
  let removed = 0;
  const now = Date.now();
  for (const segment of fs.readdirSync(usersRoot)) {
    if (!/^[a-f0-9]{32}$/i.test(segment)) continue;
    const incomingRoot = path.join(usersRoot, segment, "incoming-downloads");
    if (!fs.existsSync(incomingRoot)) continue;
    for (const project of fs.readdirSync(incomingRoot)) {
      const projectIncoming = path.join(incomingRoot, project);
      if (!fs.statSync(projectIncoming).isDirectory()) continue;
      for (const op of fs.readdirSync(projectIncoming)) {
        const opDir = path.join(projectIncoming, op);
        if (!fs.statSync(opDir).isDirectory()) continue;
        const age = now - fs.statSync(opDir).mtimeMs;
        if (age < maxAgeMs) continue; // 活跃或未过期
        safeRemoveIncomingDir(opDir, projectIncoming);
        removed += 1;
      }
    }
  }
  return removed;
}

function mediaTypeForPath(relativePath: string): "image" | "video" | "audio" | "text" | "binary" {
  const extension = relativePath.split(".").at(-1)?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "webp", "gif", "avif"].includes(extension)) return "image";
  // 中文注释：必须与 project-file-store 的视频扩展一致，避免 AVI 同步后被降级为 binary。
  if (["mp4", "webm", "mov", "mkv", "avi"].includes(extension)) return "video";
  if (["mp3", "wav", "m4a", "aac", "flac"].includes(extension)) return "audio";
  if (["txt", "md", "json", "yaml", "yml", "csv", "srt", "vtt"].includes(extension)) return "text";
  return "binary";
}

function countMediaKinds(
  objects: Array<{ relativePath: string; mediaType?: string }>,
): { database: number; image: number; video: number; audio: number; other: number } {
  const counts = { database: 0, image: 0, video: 0, audio: 0, other: 0 };
  for (const object of objects) {
    if (object.relativePath === "project.sqlite") {
      counts.database += 1;
      continue;
    }
    const kind = object.mediaType ?? mediaTypeForPath(object.relativePath);
    if (kind === "image") counts.image += 1;
    else if (kind === "video") counts.video += 1;
    else if (kind === "audio") counts.audio += 1;
    else counts.other += 1;
  }
  return counts;
}

/** 响应体直接流入目标文件，边写边算 size/MD5，禁止整包进内存。 */
async function streamResponseToFile(
  response: Response,
  targetPath: string,
): Promise<{ size: number; md5: string }> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(targetPath, bytes, { mode: 0o600 });
    return {
      size: bytes.length,
      md5: crypto.createHash("md5").update(bytes).digest("hex"),
    };
  }
  const hash = crypto.createHash("md5");
  let size = 0;
  const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  const write = fs.createWriteStream(targetPath, { mode: 0o600 });
  nodeStream.on("data", (chunk: Buffer | string) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    hash.update(buf);
  });
  await pipeline(nodeStream, write);
  return { size, md5: hash.digest("hex") };
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { ProjectStore } from "../data/project-store";
import { destroyProjectDatabaseHandle } from "@/utils/db";
import { projectDirectory } from "../data/paths";
import type { PersonalLocal, PersonalManifest } from "../sync/personal-project-sync";
import type { TeamLocal } from "../sync/team-project-sync";
import type { LegacyResourceTable } from "./legacy-project-guard";
import {
  assertNoImageBase64,
  assertSQLiteHasNoImageBase64,
} from "../media/media-safety";
import {
  buildCompleteProjectObjectSet,
  hashFileStreaming,
} from "../media/project-file-inventory";

export interface DownloadedProjectSnapshot extends PersonalManifest {
  records: Record<string, unknown>;
  /**
   * 兼容旧路径：小对象可内联。大文件应使用 stagingFiles。
   * 中文注释：禁止把完整项目媒体全部装入内存。
   */
  objectContents?: Record<string, Uint8Array>;
  /** 已校验的 .incoming 暂存文件绝对路径（relativePath → disk path）。 */
  stagingFiles?: Record<string, string>;
  /** 本轮下载 operation 根目录（安装成功/失败后必须删除）。 */
  incomingRoot?: string;
  /** 与 incomingRoot 同义，兼容测试命名。 */
  stagingRoot?: string;
}

export interface ProjectRecoveryEntry {
  recoveryId: string;
  projectUuid: string;
  reason: string;
  createdAt: string;
  databaseMD5: string;
  resolved: boolean;
  resolution?: "keep_backup";
  resolvedAt?: string;
}

export class RuntimeProjectLocal implements PersonalLocal, TeamLocal {
  current?: PersonalManifest;
  dirty = false;
  private store?: ProjectStore;
  private downloaded?: DownloadedProjectSnapshot;
  private writable = false;
  /** 本轮 createSnapshot 捕获的对象集合；上传期间只允许读取该集合。 */
  private capturedSyncObjects?: Map<string, { md5: string; size: number; absolutePath: string }>;

  constructor(
    private readonly dataRoot: string,
    readonly projectUuid: string,
    private readonly userSegment?: string,
  ) {
    const manifestPath = this.manifestPath();
    if (fs.existsSync(manifestPath)) {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PersonalManifest;
      if (Number.isSafeInteger(parsed.version) && Array.isArray(parsed.objects)) {
        this.current = parsed;
      }
    }
  }

  acceptDownloaded(snapshot: DownloadedProjectSnapshot): void {
    assertNoImageBase64(snapshot.records, "下载项目记录");
    this.downloaded = structuredClone(snapshot);
  }

  needsInstall(remote: PersonalManifest): boolean {
    if (remote.version === 0) return false;
    // 中文注释：完整对象集合比较——必须校验磁盘真实 size/MD5，禁止仅凭路径存在判定已安装。
    if (!this.current?.objects?.length) return true;
    if (this.current.objects.length !== remote.objects.length) return true;
    const localMap = new Map(
      this.current.objects.map((item) => [item.relativePath, `${item.size ?? ""}:${item.md5.toLowerCase()}`]),
    );
    for (const object of remote.objects) {
      const key = `${object.size ?? ""}:${object.md5.toLowerCase()}`;
      if (localMap.get(object.relativePath) !== key) return true;
      if (object.relativePath === "project.sqlite") {
        const databasePath = path.join(this.projectRoot(), "project.sqlite");
        if (
          !fs.existsSync(databasePath)
          || this.current.installedDatabaseMD5?.toLowerCase() !== object.md5.toLowerCase()
        ) {
          return true;
        }
      } else {
        const absolute = path.join(this.projectRoot(), ...object.relativePath.split("/"));
        if (!fs.existsSync(absolute)) return true;
        // 中文注释：fail-closed——媒体必须流式校验 size/MD5，禁止 readFileSync 全量装入。
        try {
          const digest = hashFileStreaming(absolute, {
            filesRoot: path.join(this.projectRoot(), "files"),
          });
          if (
            digest.size !== (object.size ?? digest.size)
            || digest.md5 !== object.md5.toLowerCase()
          ) {
            return true;
          }
        } catch {
          return true;
        }
      }
    }
    return false;
  }

  async install(value: PersonalManifest | boolean, _changedPaths?: string[]): Promise<void> {
    const readonly = typeof value === "boolean" ? value : false;
    const manifest = typeof value === "boolean" ? this.downloaded : value;
    const downloaded = this.downloaded;
    const canInstallDownloaded = Boolean(
      manifest
      && downloaded
      && downloaded.version === manifest.version
      && (
        downloaded.objectContents?.["project.sqlite"]
        || downloaded.stagingFiles?.["project.sqlite"]
      ),
    );
    let installedDatabaseMD5 = this.current?.installedDatabaseMD5;

    if (canInstallDownloaded) {
      installedDatabaseMD5 = await this.installDownloadedProject(downloaded!);
    }

    this.ensureStore();
    if (this.downloaded) {
      for (const [compoundKey, recordValue] of Object.entries(this.downloaded.records)) {
        const separator = compoundKey.indexOf("/");
        const namespace = separator > 0 ? compoundKey.slice(0, separator) : "runtime";
        const key = separator > 0 ? compoundKey.slice(separator + 1) : compoundKey;
        this.store!.setRecord(namespace, key || "root", recordValue);
      }
    }
    if (manifest) {
      const database = manifest.objects.find((item) => item.relativePath === "project.sqlite");
      // 中文注释：本机发布成功时 downloaded 是旧版本；中央已确认新对象后同样可写安装回执。
      if (!canInstallDownloaded && typeof value !== "boolean" && database) {
        installedDatabaseMD5 = database.md5.toLowerCase();
      }
      this.current = {
        version: manifest.version,
        objects: structuredClone(manifest.objects),
        ...(installedDatabaseMD5 ? { installedDatabaseMD5 } : {}),
      };
      this.writeManifestAtomically(this.current);
    }
    this.downloaded = undefined;
    this.writable = !readonly;
    this.store!.switchMode(readonly ? "readonly" : "readwrite");
  }

  setRecord(namespace: string, key: string, value: unknown): void {
    // 只读切换是单向安全门，任何业务调用都不能靠重新打开 SQLite 绕过权限。
    if (!this.writable) throw new Error("项目本地存储当前只读");
    this.ensureStore();
    this.store!.setRecord(namespace, key, value);
    this.dirty = true;
  }

  hasLegacyResource(table: LegacyResourceTable, id: number): boolean {
    this.ensureStore();
    return this.store!.hasLegacyResource(table, id);
  }

  markLegacyEdited(): void {
    if (!this.writable) throw new Error("项目本地存储当前只读");
    this.dirty = true;
  }

  /** 只允许协调器在会话、设备和团队锁全部验证后显式开启写模式。 */
  setWritable(): void {
    this.ensureStore();
    this.store!.switchMode("readwrite");
    this.writable = true;
  }

  /**
   * 创建同步快照。
   * generation 必须从 snapshot 副本读取后再剥离 journal；禁止 backup 后读 live。
   * afterBackup：测试钩子（backup 完成后、读 capture 前），模拟 N+1 写入 live。
   */
  async createSnapshot(options?: {
    afterBackup?: () => void | Promise<void>;
  }): Promise<PersonalManifest> {
    if (!this.store || !this.current) throw new Error("项目尚未加载");
    const snapshotPath = this.snapshotPath();
    fs.rmSync(snapshotPath, { force: true });
    // 活跃库可能处于 WAL 模式；必须通过 SQLite Backup API 生成一致快照后再计算摘要。
    await this.store.backupTo(snapshotPath);
    // 中文注释：测试钩子写 live 前释放 store，整段 snapshot 处理完成后再打开
    const needReopen = Boolean(options?.afterBackup);
    if (needReopen) {
      this.store.close();
      this.store = undefined;
      await options!.afterBackup!();
    }
    // 中文注释：仅从 snapshot 副本捕获 generation，然后再剥离 journal
    const {
      readMutationCaptureFromSqliteFile,
      captureToManifestField,
      stripMutationJournalFromSnapshotFile,
    } = await import("./legacy-mutation-journal");
    let capturedMutationGeneration: number | "unknown";
    try {
      const capture = readMutationCaptureFromSqliteFile(snapshotPath);
      capturedMutationGeneration = captureToManifestField(capture);
    } catch (err) {
      throw new Error(
        `读取快照 mutation capture 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      await stripMutationJournalFromSnapshotFile(snapshotPath);
    } catch (err) {
      throw new Error(
        `剥离快照 journal 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    assertSQLiteHasNoImageBase64(snapshotPath);
    const bytes = fs.readFileSync(snapshotPath);
    const md5 = crypto.createHash("md5").update(bytes).digest("hex");
    // 中文注释：在同步单飞锁内捕获 files 清单；上传期间只允许读取本轮已捕获对象，禁止重新枚举 live 目录。
    const completeObjects = buildCompleteProjectObjectSet({
      projectRoot: this.projectRoot(),
      sqlitePath: snapshotPath,
      sqliteMd5: md5,
      sqliteSize: bytes.length,
    });
    const captured = new Map<string, { md5: string; size: number; absolutePath: string }>();
    for (const object of completeObjects) {
      if (object.relativePath === "project.sqlite") {
        captured.set(object.relativePath, {
          md5: object.md5,
          size: object.size,
          absolutePath: snapshotPath,
        });
      } else {
        const absolutePath = path.join(this.projectRoot(), ...object.relativePath.split("/"));
        captured.set(object.relativePath, {
          md5: object.md5,
          size: object.size,
          absolutePath,
        });
      }
    }
    this.capturedSyncObjects = captured;
    if (needReopen) {
      this.ensureStore();
      this.setWritable();
    }
    return {
      version: this.current.version,
      objects: completeObjects.map((object) => ({
        relativePath: object.relativePath,
        md5: object.md5,
        size: object.size,
        ...(object.mediaType ? { mediaType: object.mediaType } : {}),
      })),
      capturedMutationGeneration,
    };
  }

  /**
   * 下载盘点：只解析本地已存在的项目文件，缺失时返回 undefined，不得抛错。
   * 中文注释：禁止把上传捕获集合用在打开/下载路径。
   */
  resolveLocalInventoryPath(relativePath: string): string | undefined {
    if (
      !relativePath
      || relativePath.startsWith("/")
      || relativePath.includes("\\")
      || relativePath.includes(":")
      || relativePath.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      return undefined;
    }
    const absolutePath = relativePath === "project.sqlite"
      ? path.join(this.projectRoot(), "project.sqlite")
      : path.join(this.projectRoot(), ...relativePath.split("/"));
    return fs.existsSync(absolutePath) ? absolutePath : undefined;
  }

  /**
   * 返回本轮捕获对象的绝对路径，供流式 checksum / multipart 分片读取。
   * 中文注释：禁止上传路径绕过捕获集合。
   */
  resolveSyncObjectPath(relativePath: string, expected: { md5: string; size?: number }): string {
    const captured = this.capturedSyncObjects?.get(relativePath);
    if (!captured) {
      throw new Error("项目同步对象未列入本轮清单或路径无效");
    }
    if (
      relativePath.startsWith("/")
      || relativePath.includes("\\")
      || relativePath.includes(":")
      || relativePath.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error("项目同步对象路径无效");
    }
    if (
      captured.md5.toLowerCase() !== expected.md5.toLowerCase()
      || (expected.size !== undefined && captured.size !== expected.size)
    ) {
      throw new Error("项目同步对象内容与清单不一致");
    }
    if (!fs.existsSync(captured.absolutePath)) throw new Error("项目同步对象不存在");
    return captured.absolutePath;
  }

  readSyncObject(relativePath: string, expected: { md5: string; size?: number }): Buffer {
    // 中文注释：上传只读取本轮 createSnapshot 捕获集合；未列入清单的路径一律拒绝，防止越界与半文件。
    const absolutePath = this.resolveSyncObjectPath(relativePath, expected);
    const captured = this.capturedSyncObjects!.get(relativePath)!;
    const bytes = fs.readFileSync(absolutePath);
    const md5 = crypto.createHash("md5").update(bytes).digest("hex");
    if (
      md5 !== expected.md5.toLowerCase()
      || md5 !== captured.md5.toLowerCase()
      || (expected.size !== undefined && bytes.length !== expected.size)
      || bytes.length !== captured.size
    ) {
      throw new Error("项目同步对象内容与清单不一致");
    }
    return bytes;
  }

  readMedia(relativePath: string, expected: { md5: string; size: number }): Buffer {
    if (
      relativePath.startsWith("/")
      || relativePath.includes("\\")
      || relativePath.includes(":")
      || relativePath.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error("本地媒体相对路径无效");
    }
    const root = fs.realpathSync(this.projectRoot());
    const filename = fs.realpathSync(path.resolve(root, relativePath));
    const scoped = path.relative(root, filename);
    if (!scoped || scoped.startsWith("..") || path.isAbsolute(scoped)) {
      throw new Error("本地媒体路径越出当前项目");
    }
    const bytes = fs.readFileSync(filename);
    const md5 = crypto.createHash("md5").update(bytes).digest("hex");
    if (bytes.length !== expected.size || md5 !== expected.md5.toLowerCase()) {
      throw new Error("本地媒体内容与持久元数据不一致");
    }
    return bytes;
  }

  async setReadonly(_reason: string): Promise<void> {
    this.writable = false;
    this.store?.switchMode("readonly");
  }

  async createRecovery(reason: string): Promise<void> {
    const recoveryDirectory = this.recoveryDirectory();
    const recoveryId = `${Date.now()}-${reason}`;
    const recoverySnapshot = path.join(recoveryDirectory, recoveryId);
    fs.mkdirSync(recoverySnapshot, { recursive: true });
    if (this.store) {
      await this.store.backupTo(path.join(recoverySnapshot, "project.sqlite"));
    }
    const projectRoot = this.projectRoot();
    const sourceFiles = path.join(projectRoot, "files");
    if (fs.existsSync(sourceFiles)) {
      fs.cpSync(sourceFiles, path.join(recoverySnapshot, "files"), { recursive: true });
    }
    const sourceManifest = this.manifestPath();
    if (fs.existsSync(sourceManifest)) {
      fs.copyFileSync(sourceManifest, path.join(recoverySnapshot, ".tianjiang-manifest.json"));
    }
    // 恢复清单与 SQLite、素材同目录落盘，不包含令牌、模型密钥或远端凭据。
    fs.writeFileSync(path.join(recoverySnapshot, "recovery.json"), JSON.stringify({
      projectUuid: this.projectUuid,
      reason,
      createdAt: new Date().toISOString(),
      databaseMD5: fs.existsSync(path.join(recoverySnapshot, "project.sqlite"))
        ? crypto.createHash("md5").update(fs.readFileSync(path.join(recoverySnapshot, "project.sqlite"))).digest("hex")
        : "",
    }, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  listRecoveries(): ProjectRecoveryEntry[] {
    const root = this.recoveryDirectory();
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && validRecoveryId(entry.name))
      .map((entry) => {
        const manifest = path.join(root, entry.name, "recovery.json");
        if (!fs.existsSync(manifest)) return undefined;
        try {
          const value = JSON.parse(fs.readFileSync(manifest, "utf8")) as Record<string, unknown>;
          if (value.projectUuid !== this.projectUuid) return undefined;
          return {
            recoveryId: entry.name,
            projectUuid: this.projectUuid,
            reason: typeof value.reason === "string" ? value.reason : "unknown",
            createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
            databaseMD5: typeof value.databaseMD5 === "string" ? value.databaseMD5 : "",
            resolved: value.resolved === true,
            ...(value.resolution === "keep_backup" ? { resolution: "keep_backup" as const } : {}),
            ...(typeof value.resolvedAt === "string" ? { resolvedAt: value.resolvedAt } : {}),
          };
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is ProjectRecoveryEntry => Boolean(entry))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  resolveRecovery(recoveryId: string, resolution: "keep_backup"): ProjectRecoveryEntry {
    if (!validRecoveryId(recoveryId) || resolution !== "keep_backup") {
      throw new Error("恢复处理参数无效");
    }
    const root = path.resolve(this.recoveryDirectory());
    const directory = path.resolve(root, recoveryId);
    if (path.dirname(directory) !== root) throw new Error("恢复副本路径无效");
    const manifest = path.join(directory, "recovery.json");
    if (!fs.existsSync(manifest)) throw new Error("恢复副本不存在");
    const current = JSON.parse(fs.readFileSync(manifest, "utf8")) as Record<string, unknown>;
    if (current.projectUuid !== this.projectUuid) throw new Error("恢复副本不属于当前项目");
    const next = {
      ...current,
      resolved: true,
      resolution,
      resolvedAt: new Date().toISOString(),
    };
    const temporary = `${manifest}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, manifest);
    return this.listRecoveries().find((entry) => entry.recoveryId === recoveryId)!;
  }

  close(): void {
    this.store?.close();
    this.store = undefined;
    this.writable = false;
  }

  private ensureStore(): void {
    if (!this.store) {
      this.store = new ProjectStore(this.dataRoot, this.projectUuid, "readwrite", this.userSegment);
    }
  }

  /**
   * 校验并原子安装完整中央项目（sqlite + files）。
   * 中文注释：任一对象失败必须回滚；禁止只装数据库或留下半截新媒体破坏旧项目。
   */
  private async installDownloadedProject(snapshot: DownloadedProjectSnapshot): Promise<string> {
    const descriptor = snapshot.objects.find((item) => item.relativePath === "project.sqlite");
    if (!descriptor) throw new Error("下载项目快照缺少 project.sqlite");
    const incomingOp = snapshot.incomingRoot ?? snapshot.stagingRoot;

    // 中文注释：优先消费已校验 staging 文件；兼容旧 objectContents 小对象路径。
    const resolveSource = (relativePath: string): { kind: "file"; path: string } | { kind: "bytes"; bytes: Buffer } => {
      const staged = snapshot.stagingFiles?.[relativePath];
      if (staged && fs.existsSync(staged)) return { kind: "file", path: staged };
      const content = snapshot.objectContents?.[relativePath];
      if (content) return { kind: "bytes", bytes: Buffer.from(content) };
      // 中文注释：未变化对象不重复下载，安装时复用本机已校验文件。
      const localPath = path.join(this.projectRoot(), ...relativePath.split("/"));
      const expected = snapshot.objects.find((item) => item.relativePath === relativePath);
      if (expected && fs.existsSync(localPath)) {
        const digest = hashFileStreaming(localPath, relativePath.startsWith("files/")
          ? { filesRoot: path.join(this.projectRoot(), "files") }
          : undefined);
        if (digest.size === (expected.size ?? digest.size) && digest.md5 === expected.md5.toLowerCase()) {
          return { kind: "file", path: localPath };
        }
      }
      throw new Error(`下载项目缺少对象：${relativePath}`);
    };

    try {
      for (const object of snapshot.objects) {
        if (
          object.relativePath !== "project.sqlite"
          && (
            object.relativePath.startsWith("/")
            || object.relativePath.includes("\\")
            || object.relativePath.includes(":")
            || object.relativePath.split("/").some((part) => !part || part === "." || part === "..")
            || !object.relativePath.startsWith("files/")
          )
        ) {
          throw new Error(`下载项目对象路径无效：${object.relativePath}`);
        }
        const source = resolveSource(object.relativePath);
        if (source.kind === "bytes") {
          // 中文注释：仅小对象内联允许 buffer；媒体路径必须是 staging 文件。
          const md5 = crypto.createHash("md5").update(source.bytes).digest("hex");
          if (source.bytes.length !== object.size || md5 !== object.md5.toLowerCase()) {
            throw new Error(`下载项目对象与中央清单不一致：${object.relativePath}`);
          }
        } else if (object.relativePath === "project.sqlite") {
          const bytes = fs.readFileSync(source.path);
          const md5 = crypto.createHash("md5").update(bytes).digest("hex");
          if (bytes.length !== object.size || md5 !== object.md5.toLowerCase()) {
            throw new Error(`下载项目对象与中央清单不一致：${object.relativePath}`);
          }
        } else {
          // 中文注释：媒体流式校验，禁止 readFileSync。
          const projectFilesRoot = path.resolve(this.projectRoot(), "files");
          const resolvedSource = path.resolve(source.path);
          const sourceIsLocalProjectFile = resolvedSource.startsWith(`${projectFilesRoot}${path.sep}`);
          const digest = hashFileStreaming(source.path, sourceIsLocalProjectFile
            ? { filesRoot: projectFilesRoot }
            : undefined);
          if (digest.size !== object.size || digest.md5 !== object.md5.toLowerCase()) {
            throw new Error(`下载项目对象与中央清单不一致：${object.relativePath}`);
          }
        }
      }

      const dbSource = resolveSource("project.sqlite");
      const databaseBytes = dbSource.kind === "bytes"
        ? dbSource.bytes
        : fs.readFileSync(dbSource.path);
      const md5 = crypto.createHash("md5").update(databaseBytes).digest("hex");
      return await this.installDownloadedProjectBody(snapshot, resolveSource, md5);
    } finally {
      // 中文注释：成功/失败/回滚均删除本轮 download operation 目录。
      if (incomingOp) {
        const parent = path.dirname(incomingOp);
        const resolved = path.resolve(incomingOp);
        if (resolved.startsWith(path.resolve(parent) + path.sep)) {
          fs.rmSync(resolved, { recursive: true, force: true });
        }
      }
    }
  }

  private async installDownloadedProjectBody(
    snapshot: DownloadedProjectSnapshot,
    resolveSource: (relativePath: string) => { kind: "file"; path: string } | { kind: "bytes"; bytes: Buffer },
    md5: string,
  ): Promise<string> {

    // 中文注释：旧 UI 的 Knex 项目连接与同步层 ProjectStore 是两套句柄；两者都必须先释放。
    if (this.userSegment) {
      await destroyProjectDatabaseHandle(this.userSegment, this.projectUuid);
    }
    this.store?.close();
    this.store = undefined;
    const currentRoot = this.projectRoot();
    fs.mkdirSync(path.join(currentRoot, "files"), { recursive: true });
    const projectsRoot = path.dirname(currentRoot);
    const attemptId = crypto.randomUUID();
    const stagingRoot = path.join(
      projectsRoot,
      `.${this.projectUuid}.incoming-${process.pid}-${attemptId}`,
    );
    const recoveryId = `${Date.now()}-before_remote_install-${crypto.randomUUID()}`;
    const recoveryRoot = this.recoveryDirectory();
    const previousRoot = path.join(recoveryRoot, recoveryId);
    let currentMoved = false;

    try {
      // 中文注释：独立 .incoming 暂存目录逐对象落盘；全部成功后才原子切换。
      fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(stagingRoot, "files"), { recursive: true });

      for (const object of snapshot.objects) {
        const source = resolveSource(object.relativePath);
        const target = object.relativePath === "project.sqlite"
          ? path.join(stagingRoot, "project.sqlite")
          : path.join(stagingRoot, ...object.relativePath.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (source.kind === "file") {
          fs.copyFileSync(source.path, target);
        } else {
          fs.writeFileSync(target, source.bytes, { mode: 0o600 });
        }
        const file = fs.openSync(target, "r+");
        try {
          fs.fsyncSync(file);
        } finally {
          fs.closeSync(file);
        }
      }
      fs.rmSync(path.join(stagingRoot, "project.sqlite-wal"), { force: true });
      fs.rmSync(path.join(stagingRoot, "project.sqlite-shm"), { force: true });
      assertDownloadedSQLite(path.join(stagingRoot, "project.sqlite"));

      const nextManifest: PersonalManifest = {
        version: snapshot.version,
        objects: structuredClone(snapshot.objects),
        installedDatabaseMD5: md5,
      };
      fs.writeFileSync(
        path.join(stagingRoot, ".tianjiang-manifest.json"),
        JSON.stringify(nextManifest, null, 2),
        { encoding: "utf8", mode: 0o600 },
      );

      fs.mkdirSync(recoveryRoot, { recursive: true });
      fs.renameSync(currentRoot, previousRoot);
      currentMoved = true;
      fs.renameSync(stagingRoot, currentRoot);
      fs.writeFileSync(path.join(previousRoot, "recovery.json"), JSON.stringify({
        projectUuid: this.projectUuid,
        reason: "before_remote_install",
        createdAt: new Date().toISOString(),
        databaseMD5: fs.existsSync(path.join(previousRoot, "project.sqlite"))
          ? crypto.createHash("md5").update(fs.readFileSync(path.join(previousRoot, "project.sqlite"))).digest("hex")
          : "",
        // 中文注释：这是已校验远端安装的自动回滚点，不是待用户处理的数据冲突。
        resolved: true,
        resolution: "keep_backup",
        resolvedAt: new Date().toISOString(),
      }, null, 2), { encoding: "utf8", mode: 0o600 });
      return md5;
    } catch (error) {
      try {
        if (currentMoved && fs.existsSync(previousRoot)) {
          // 中文注释：即使失败发生在新目录已经就位之后，也必须先移走新目录，再恢复唯一旧副本。
          if (fs.existsSync(currentRoot)) {
            fs.renameSync(currentRoot, stagingRoot);
          }
          fs.renameSync(previousRoot, currentRoot);
        }
      } catch (rollbackError) {
        throw new Error("安装中央项目数据库失败且旧项目回滚失败", { cause: rollbackError });
      }
      throw new Error("安装中央项目数据库失败", { cause: error });
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  }

  private writeManifestAtomically(manifest: PersonalManifest): void {
    const filename = this.manifestPath();
    const temporary = `${filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, filename);
  }

  private manifestPath(): string {
    return path.join(this.projectRoot(), ".tianjiang-manifest.json");
  }

  private snapshotPath(): string {
    return path.join(
      this.dataRoot,
      ...(this.userSegment ? ["runtime-users", this.userSegment, "sync"] : ["sync"]),
      "snapshots",
      this.projectUuid,
      "project.sqlite",
    );
  }

  private projectRoot(): string {
    return this.userSegment
      ? projectDirectory(this.dataRoot, this.projectUuid, this.userSegment)
      : path.resolve(this.dataRoot, "projects", this.projectUuid);
  }

  private recoveryDirectory(): string {
    return this.userSegment
      ? path.join(this.dataRoot, "runtime-users", this.userSegment, "sync", "recovery", this.projectUuid)
      : path.join(this.dataRoot, "sync", "recovery", this.projectUuid);
  }
}

function validRecoveryId(value: string): boolean {
  return /^[0-9]{10,}-[a-z0-9_-]{1,80}$/i.test(value);
}

function assertDownloadedSQLite(filename: string): void {
  const database = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const rows = database.pragma("integrity_check") as Array<Record<string, unknown>>;
    if (rows.length !== 1 || String(rows[0]?.integrity_check ?? "").toLowerCase() !== "ok") {
      throw new Error("下载项目数据库完整性校验失败");
    }
  } finally {
    database.close();
  }
  assertSQLiteHasNoImageBase64(filename);
}

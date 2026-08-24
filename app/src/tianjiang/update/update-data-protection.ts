import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface UpdateBackupFile {
  path: string;
  size: number;
  sha256: string;
}

export interface UpdateBackupResult {
  backupDir: string;
  manifestPath: string;
  fileCount: number;
  totalBytes: number;
}

function hashFileSha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function assertInside(parent: string, candidate: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("更新备份路径越界");
  }
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("更新备份拒绝符号链接");
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) files.push(absolutePath);
      else throw new Error(`更新备份不支持的文件类型：${entry.name}`);
    }
  };
  visit(root);
  return files;
}

/**
 * 安装器启动前完整复制 userData/data，并对源文件与备份文件逐一复算 SHA-256。
 * 任一文件失败都删除未完成暂存目录且向上抛错，安装流程必须停止。
 */
export async function protectUserDataBeforeUpdate(options: {
  userDataRoot: string;
}): Promise<UpdateBackupResult> {
  const userDataRoot = path.resolve(options.userDataRoot);
  const dataRoot = path.join(userDataRoot, "data");
  const backupsRoot = path.join(userDataRoot, "update-backups");
  const backupId = `pre-update-${Date.now()}-${crypto.randomUUID()}`;
  const stagingDir = path.join(backupsRoot, `.${backupId}.staging`);
  const backupDir = path.join(backupsRoot, backupId);
  assertInside(userDataRoot, stagingDir);
  assertInside(userDataRoot, backupDir);
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    const manifestFiles: UpdateBackupFile[] = [];
    for (const sourcePath of listFiles(dataRoot)) {
      const relativePath = path.relative(dataRoot, sourcePath);
      const normalizedPath = relativePath.replaceAll("\\", "/");
      const destinationPath = path.join(stagingDir, "data", relativePath);
      assertInside(stagingDir, destinationPath);
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      const sourceHash = hashFileSha256(sourcePath);
      fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
      const destinationHash = hashFileSha256(destinationPath);
      if (destinationHash !== sourceHash) throw new Error(`更新备份 SHA-256 不一致：${normalizedPath}`);
      const size = fs.statSync(destinationPath).size;
      manifestFiles.push({ path: normalizedPath, size, sha256: destinationHash });
    }

    const manifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      source: "userData/data",
      files: manifestFiles,
      fileCount: manifestFiles.length,
      totalBytes: manifestFiles.reduce((total, file) => total + file.size, 0),
    };
    const stagingManifestPath = path.join(stagingDir, "manifest.json");
    fs.writeFileSync(stagingManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    fs.renameSync(stagingDir, backupDir);
    return {
      backupDir,
      manifestPath: path.join(backupDir, "manifest.json"),
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
    };
  } catch (error) {
    assertInside(userDataRoot, stagingDir);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

export function assertNoZipUserDataOverwrite(source: string): void {
  if (source.includes("compressing.zip.uncompress") || source.includes("fs.cpSync(rootDir, dataDir")) {
    throw new Error("禁止 ZIP 解压覆盖用户数据目录");
  }
}

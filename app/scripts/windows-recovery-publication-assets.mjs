import { createHash } from "node:crypto";

import yaml from "js-yaml";

const SAFE_ASSET_NAME = /^[a-z0-9][a-z0-9._-]+$/;

function fail(reason) {
  throw new Error(`Windows Beta 恢复准备失败：${reason}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeMetadataName(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label}缺少文件名`);
  try {
    return decodeURIComponent(value);
  } catch {
    fail(`${label}不是有效编码文件名`);
  }
}

function publicationInstallerName(version) {
  const name = `tianjiang-manchuang-${version}-win-x64-setup.exe`;
  if (!SAFE_ASSET_NAME.test(name)) fail("GitHub 附件名不安全");
  return name;
}

function rewriteMetadata(bytes, sourceInstaller, outputInstaller) {
  let metadata;
  try {
    metadata = yaml.load(bytes.toString("utf8"));
  } catch {
    fail("latest.yml 不是有效 YAML");
  }
  if (!metadata || typeof metadata !== "object" || !Array.isArray(metadata.files) || metadata.files.length !== 1) {
    fail("latest.yml Windows 文件集合漂移");
  }
  const file = metadata.files[0];
  if (
    !file
    || typeof file !== "object"
    || decodeMetadataName(file.url, "latest.yml files.url") !== sourceInstaller
    || decodeMetadataName(metadata.path, "latest.yml path") !== sourceInstaller
  ) {
    fail("latest.yml 源安装包名称漂移");
  }
  // 仅改写 GitHub Release 外部名；SHA-512、size、版本和时间等已验证字段保持不变。
  const publicationMetadata = {
    ...metadata,
    files: [{ ...file, url: outputInstaller }],
    path: outputInstaller,
  };
  return Buffer.from(yaml.dump(publicationMetadata, { lineWidth: -1, noRefs: true }), "utf8");
}

/**
 * 将已验证的中文源 Artifact 转换为 GitHub-safe ASCII 发布附件，并重生 metadata/index。
 */
export function buildWindowsRecoveryPublicationAttachments({ index, bytesByName, version }) {
  const installerEntry = index.files.find((entry) => entry.kind === "installer");
  const blockmapEntry = index.files.find((entry) => entry.kind === "blockmap");
  const metadataEntry = index.files.find((entry) => entry.kind === "metadata");
  if (!installerEntry || !blockmapEntry || !metadataEntry) fail("源产物类型集合漂移");
  if (blockmapEntry.fileName !== `${installerEntry.fileName}.blockmap` || metadataEntry.fileName !== "latest.yml") {
    fail("源产物名称集合漂移");
  }
  const installerBytes = bytesByName.get(installerEntry.fileName);
  const blockmapBytes = bytesByName.get(blockmapEntry.fileName);
  const metadataBytes = bytesByName.get(metadataEntry.fileName);
  if (!installerBytes || !blockmapBytes || !metadataBytes) fail("源产物字节缺失");

  const outputInstaller = publicationInstallerName(version);
  const outputBlockmap = `${outputInstaller}.blockmap`;
  const outputMetadata = rewriteMetadata(metadataBytes, installerEntry.fileName, outputInstaller);
  const files = [
    { fileName: "latest.yml", kind: "metadata", bytes: outputMetadata },
    { fileName: outputInstaller, kind: "installer", bytes: installerBytes },
    { fileName: outputBlockmap, kind: "blockmap", bytes: blockmapBytes },
  ].sort((left, right) => left.fileName.localeCompare(right.fileName, "en"));
  const publicationIndex = {
    schemaVersion: 1,
    targetId: "windows-x64",
    platform: "windows",
    arch: "x64",
    metadataFile: "latest.yml",
    files: files.map(({ fileName, kind, bytes }) => ({
      fileName,
      kind,
      size: bytes.length,
      sha256: sha256(bytes),
    })),
  };
  const indexBytes = Buffer.from(`${JSON.stringify(publicationIndex, null, 2)}\n`, "utf8");
  return new Map([
    ...files.map(({ fileName, bytes }) => [fileName, bytes]),
    ["target-index.json", indexBytes],
  ]);
}

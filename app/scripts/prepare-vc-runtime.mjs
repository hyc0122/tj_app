import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(appRoot, "..");
const prerequisiteRoot = path.join(projectRoot, ".local", "prerequisites");
const runtimePath = path.join(prerequisiteRoot, "vc_redist.x64.exe");
const metadataPath = path.join(prerequisiteRoot, "vc_redist.x64.json");
export const OFFICIAL_VC_RUNTIME_URL =
  "https://aka.ms/vs/17/release/vc_redist.x64.exe";

function assertRuntimePath(target) {
  if (path.resolve(target) !== runtimePath) {
    throw new Error(`拒绝写入非固定 VC++ 运行库路径：${target}`);
  }
}

function verifyPortableExecutable(target) {
  const content = readFileSync(target);
  if (content.length < 1_000_000 || content[0] !== 0x4d || content[1] !== 0x5a) {
    throw new Error("VC++ 运行库文件不是有效的 Windows PE 安装包");
  }
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function assertVcRuntimeIdentity(identity) {
  const companyName = String(identity?.companyName ?? "");
  const originalFilename = String(identity?.originalFilename ?? "");
  const productName = String(identity?.productName ?? "");
  if (
    companyName !== "Microsoft Corporation"
    || originalFilename.toLowerCase() !== "vc_redist.x64.exe"
    || !/^Microsoft Visual C\+\+ 2015-2022 Redistributable \(x64\)(?:\s+-\s+[\d.]+)?$/i
      .test(productName)
  ) {
    throw new Error("VC++ 运行库产品身份验证失败");
  }
}

export function assertRuntimeProvenance(metadata, expectedSha256) {
  if (metadata?.sourceUrl !== OFFICIAL_VC_RUNTIME_URL) {
    throw new Error("VC++ 运行库缓存缺少可信的微软官方来源记录");
  }
  if (
    typeof metadata?.sha256 !== "string"
    || metadata.sha256.toLowerCase() !== expectedSha256.toLowerCase()
  ) {
    throw new Error("VC++ 运行库缓存来源记录与文件摘要不一致");
  }
}

function verifyMicrosoftSignature(target) {
  if (process.platform !== "win32") {
    throw new Error("Windows 安装器只能在 Windows 构建机准备 VC++ 运行库");
  }
  const escaped = target.replaceAll("'", "''");
  const script = [
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escaped}'`,
    "if ($signature.Status -ne 'Valid') { exit 11 }",
    "if ($signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { exit 12 }",
    "$info = (Get-Item -LiteralPath '" + escaped + "').VersionInfo",
    "[pscustomobject]@{ companyName=$info.CompanyName; originalFilename=$info.OriginalFilename; productName=$info.ProductName; fileVersion=$info.FileVersion } | ConvertTo-Json -Compress",
  ].join("; ");
  const failures = [];
  for (const executable of ["pwsh.exe", "powershell.exe"]) {
    const result = spawnSync(
      executable,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", shell: false },
    );
    if (!result.error && result.status === 0) {
      try {
        const identity = JSON.parse(result.stdout.trim());
        assertVcRuntimeIdentity(identity);
        return identity;
      } catch (error) {
        failures.push(
          `${executable}:产品身份无效:${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
    }
    failures.push(`${executable}:${result.status ?? result.error?.message}`);
  }
  throw new Error(`VC++ 运行库 Authenticode 验证失败：${failures.join(", ")}`);
}

export function verifyVcRuntimeArtifact(target) {
  const sha256 = verifyPortableExecutable(target);
  const identity = verifyMicrosoftSignature(target);
  return { sha256, identity };
}

function readRuntimeMetadata() {
  return JSON.parse(readFileSync(metadataPath, "utf8"));
}

export async function prepareVcRuntime() {
  assertRuntimePath(runtimePath);
  mkdirSync(prerequisiteRoot, { recursive: true });
  if (existsSync(runtimePath)) {
    try {
      const verified = verifyVcRuntimeArtifact(runtimePath);
      assertRuntimeProvenance(readRuntimeMetadata(), verified.sha256);
      process.stdout.write(`[VC++ 运行库] 使用已验证官方缓存：${verified.sha256}\n`);
      return runtimePath;
    } catch (error) {
      // 缓存身份或来源记录不完整时强制重新从微软官方地址获取。
      process.stdout.write(
        `[VC++ 运行库] 忽略不可信缓存：${error instanceof Error ? error.message : String(error)}\n`,
      );
      rmSync(runtimePath, { force: true });
      rmSync(metadataPath, { force: true });
    }
  }

  const temporaryPath = `${runtimePath}.download`;
  const temporaryMetadataPath = `${metadataPath}.download`;
  rmSync(temporaryPath, { force: true });
  rmSync(temporaryMetadataPath, { force: true });
  const response = await fetch(OFFICIAL_VC_RUNTIME_URL, {
    redirect: "follow",
    headers: { "user-agent": "Tianjiang-Manchuang-Build/1.0" },
  });
  if (!response.ok) {
    throw new Error(`Microsoft VC++ 运行库下载失败：HTTP ${response.status}`);
  }
  writeFileSync(temporaryPath, Buffer.from(await response.arrayBuffer()), {
    flag: "wx",
  });
  try {
    const verified = verifyVcRuntimeArtifact(temporaryPath);
    const metadata = {
      sourceUrl: OFFICIAL_VC_RUNTIME_URL,
      sha256: verified.sha256,
      verifiedAt: new Date().toISOString(),
      fileVersion: verified.identity.fileVersion,
    };
    assertRuntimeProvenance(metadata, verified.sha256);
    writeFileSync(temporaryMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(temporaryPath, runtimePath);
    renameSync(temporaryMetadataPath, metadataPath);
    process.stdout.write(`[VC++ 运行库] 官方安装包已缓存并验证：${verified.sha256}\n`);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    rmSync(temporaryMetadataPath, { force: true });
    rmSync(runtimePath, { force: true });
    rmSync(metadataPath, { force: true });
    throw error;
  }
  return runtimePath;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  prepareVcRuntime().catch((error) => {
    process.stderr.write(
      `[VC++ 运行库] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

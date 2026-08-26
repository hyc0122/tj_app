import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { COMMON_ASSETS } from "./release-relay-contract.mjs";

export const MULTIPART_THRESHOLD = 200 * 1024 * 1024;
export const MULTIPART_PART_SIZE = 8 * 1024 * 1024;
export const MULTIPART_CONCURRENCY = 4;
export const PART_MAX_ATTEMPTS = 3;

function fail(message) {
  throw new Error(`OSS 中转失败：${message}`);
}

function jsonWriteAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "w" });
  fs.renameSync(temporary, filePath);
}

function safeObjectKey(key) {
  if (
    typeof key !== "string"
    || key.length < 1
    || key.startsWith("/")
    || key.includes("..")
    || key.includes("\\")
  ) {
    fail(`OSS 对象路径非法：${key}`);
  }
  return key;
}

function buildObject({ key, releaseAsset, directory, verifiedFiles, mutable, phase }) {
  const evidence = verifiedFiles[releaseAsset];
  if (!evidence || !Number.isSafeInteger(evidence.size) || !/^[a-f0-9]{64}$/.test(evidence.sha256)) {
    fail(`下载校验证据缺失：${releaseAsset}`);
  }
  const filePath = evidence.filePath ?? path.join(directory, releaseAsset);
  if (!fs.lstatSync(filePath).isFile()) fail(`中转来源不是普通文件：${releaseAsset}`);
  return {
    key: safeObjectKey(key),
    releaseAsset,
    filePath,
    size: evidence.size,
    sha256: evidence.sha256,
    mutable,
    phase,
  };
}

/**
 * 生成三阶段 OSS 发布计划：安装产物 -> blockmap/证明 -> latest 渠道指针。
 * updater 兼容对象与版本目录对象都使用同一原始文件，不做任何重写。
 */
export function createOssPublicationPlan({ directory, manifest, verifiedFiles }) {
  const phases = [
    { name: "immutable-packages", objects: [] },
    { name: "immutable-metadata", objects: [] },
    { name: "channel-pointers", objects: [] },
  ];
  const keys = new Set();
  const append = (phaseIndex, object) => {
    if (keys.has(object.key)) fail(`OSS 对象路径重复：${object.key}`);
    keys.add(object.key);
    phases[phaseIndex].objects.push(object);
  };

  for (const artifact of manifest.artifacts) {
    if (artifact.mutable) continue;
    const phaseIndex = artifact.kind === "blockmap" ? 1 : 0;
    append(phaseIndex, buildObject({
      key: artifact.ossKey,
      releaseAsset: artifact.releaseAsset,
      directory,
      verifiedFiles,
      mutable: false,
      phase: phases[phaseIndex].name,
    }));
    append(phaseIndex, buildObject({
      key: artifact.compatibilityOssKey,
      releaseAsset: artifact.releaseAsset,
      directory,
      verifiedFiles,
      mutable: false,
      phase: phases[phaseIndex].name,
    }));
  }

  const targetDescriptors = manifest.targets.map((targetId) => {
    const artifact = manifest.artifacts.find((item) => item.targetId === targetId);
    if (!artifact) fail(`目标缺少资产：${targetId}`);
    return { targetId, platform: artifact.platform, arch: artifact.arch };
  });
  for (const target of targetDescriptors) {
    const versionRoot = `desktop/${manifest.channel}/${target.platform}/${target.arch}/catalog/releases/${manifest.version}`;
    for (const releaseAsset of COMMON_ASSETS) {
      append(1, buildObject({
        key: `${versionRoot}/${releaseAsset}`,
        releaseAsset,
        directory,
        verifiedFiles,
        mutable: false,
        phase: phases[1].name,
      }));
    }
  }

  for (const artifact of manifest.artifacts) {
    if (!artifact.mutable) continue;
    append(2, buildObject({
      key: artifact.ossKey,
      releaseAsset: artifact.releaseAsset,
      directory,
      verifiedFiles,
      mutable: true,
      phase: phases[2].name,
    }));
  }

  return {
    schemaVersion: 1,
    repository: manifest.repository,
    runId: manifest.runId,
    version: manifest.version,
    channel: manifest.channel,
    commitSha: manifest.commitSha,
    phases,
  };
}

export async function uploadLocalFile({ remote, key, filePath, size, checkpointPath }) {
  if (size >= MULTIPART_THRESHOLD) {
    return remote.multipart({
      key,
      filePath,
      size,
      partSize: MULTIPART_PART_SIZE,
      concurrency: MULTIPART_CONCURRENCY,
      maxAttempts: PART_MAX_ATTEMPTS,
      checkpointPath,
    });
  }
  return remote.put(key, filePath);
}

function sameEvidence(actual, expected) {
  return actual && actual.size === expected.size && actual.sha256 === expected.sha256;
}

/** 不可变对象全部上传并回读成功后，才进入最终渠道指针阶段。 */
export async function publishPlanToOss({ plan, remote }) {
  const report = { phases: [], pointersPublished: false };
  for (const phase of plan.phases) {
    const phaseReport = { name: phase.name, objects: [] };
    for (const object of phase.objects) {
      const existing = await remote.statAndHash(object);
      if (existing && !sameEvidence(existing, object) && !object.mutable) {
        fail(`已存在对象与待发布内容不同，拒绝覆盖：${object.key}`);
      }
      let uploadResult = { mode: "existing", attempts: [] };
      if (!existing || !sameEvidence(existing, object)) uploadResult = await remote.upload(object);
      const readback = await remote.readback(object);
      if (!sameEvidence(readback, object)) {
        fail(`OSS 回读摘要或大小不一致：${object.key}`);
      }
      phaseReport.objects.push({
        key: object.key,
        releaseAsset: object.releaseAsset,
        size: object.size,
        sha256: object.sha256,
        mode: uploadResult?.mode ?? "uploaded",
        attempts: uploadResult?.attempts ?? [],
        readback,
        pointerContent: object.mutable ? fs.readFileSync(object.filePath, "utf8") : null,
      });
    }
    report.phases.push(phaseReport);
    if (phase.name === "channel-pointers") report.pointersPublished = true;
  }
  return report;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function listUploadedParts(client, key, uploadId) {
  const parts = [];
  let marker = 0;
  while (true) {
    const result = await client.listParts(key, uploadId, {
      "max-parts": 1000,
      "part-number-marker": marker,
    });
    for (const part of result.parts ?? []) {
      parts.push({
        number: Number(part.PartNumber ?? part.number),
        etag: String(part.ETag ?? part.etag),
      });
    }
    if (String(result.isTruncated) !== "true") break;
    marker = Number(result.nextPartNumberMarker);
  }
  return parts;
}

function readCheckpoint(checkpointPath, expected) {
  if (!fs.existsSync(checkpointPath)) return null;
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  for (const field of ["key", "filePath", "size", "sha256", "partSize"]) {
    if (checkpoint[field] !== expected[field]) fail(`multipart checkpoint 与当前文件不一致：${field}`);
  }
  if (typeof checkpoint.uploadId !== "string" || checkpoint.uploadId.length < 1) {
    fail("multipart checkpoint 缺少 uploadId");
  }
  return checkpoint;
}

async function runPartWithRetry({ operation, partNumber, maxAttempts, sleepImpl }) {
  const attempts = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await operation();
      attempts.push({ partNumber, attempt, status: "success" });
      return { result, attempts };
    } catch (error) {
      attempts.push({ partNumber, attempt, status: "failure", error: error?.name ?? "Error" });
      if (attempt === maxAttempts) throw Object.assign(error, { attempts });
      await sleepImpl(500 * (2 ** (attempt - 1)));
    }
  }
  throw new Error("不可达的分片重试状态");
}

/** 使用 ali-oss 低层分片 API，逐片重试并把 uploadId/ETag 持久化到 checkpoint。 */
export async function multipartUploadWithCheckpoint({
  client,
  key,
  filePath,
  size,
  sha256,
  partSize = MULTIPART_PART_SIZE,
  concurrency = MULTIPART_CONCURRENCY,
  maxAttempts = PART_MAX_ATTEMPTS,
  checkpointPath,
  sleepImpl = sleep,
}) {
  const expected = { key, filePath, size, sha256, partSize };
  let checkpoint = readCheckpoint(checkpointPath, expected);
  if (!checkpoint) {
    const started = await client.initMultipartUpload(key);
    checkpoint = { ...expected, uploadId: started.uploadId, doneParts: [] };
    jsonWriteAtomic(checkpointPath, checkpoint);
  }

  const remoteParts = await listUploadedParts(client, key, checkpoint.uploadId);
  const completed = new Map(remoteParts.map((part) => [part.number, part.etag]));
  checkpoint.doneParts = [...completed].map(([number, etag]) => ({ number, etag }));
  jsonWriteAtomic(checkpointPath, checkpoint);

  const totalParts = Math.ceil(size / partSize);
  const todo = Array.from({ length: totalParts }, (_, index) => index + 1)
    .filter((partNumber) => !completed.has(partNumber));
  const attemptEvidence = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const partNumber = todo[cursor];
      cursor += 1;
      const start = (partNumber - 1) * partSize;
      const end = Math.min(size, start + partSize);
      const { result, attempts } = await runPartWithRetry({
        partNumber,
        maxAttempts,
        sleepImpl,
        operation: () => client.uploadPart(
          key,
          checkpoint.uploadId,
          partNumber,
          filePath,
          start,
          end,
        ),
      });
      attemptEvidence.push(...attempts);
      completed.set(partNumber, result.etag ?? result.res?.headers?.etag);
      checkpoint.doneParts = [...completed]
        .sort(([left], [right]) => left - right)
        .map(([number, etag]) => ({ number, etag }));
      jsonWriteAtomic(checkpointPath, checkpoint);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, Math.max(todo.length, 1)) },
    () => worker(),
  ));
  const doneParts = [...completed]
    .sort(([left], [right]) => left - right)
    .map(([number, etag]) => ({ number, etag }));
  await client.completeMultipartUpload(key, checkpoint.uploadId, doneParts);
  fs.rmSync(checkpointPath, { force: true });
  return { mode: "multipart", attempts: attemptEvidence, partSize, concurrency, maxAttempts };
}

async function hashReadable(stream) {
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    digest.update(bytes);
  }
  return { size, sha256: digest.digest("hex") };
}

function isMissingObject(error) {
  return error?.status === 404 || error?.code === "NoSuchKey" || error?.name === "NoSuchKeyError";
}

export function createAliOssRemote({ client, checkpointRoot }) {
  const readback = async (object) => {
    const result = await client.getStream(object.key);
    return { key: object.key, ...await hashReadable(result.stream) };
  };
  return {
    async statAndHash(object) {
      try {
        await client.head(object.key);
        return readback(object);
      } catch (error) {
        if (isMissingObject(error)) return null;
        throw error;
      }
    },
    async upload(object) {
      const checkpointName = createHash("sha256").update(object.key).digest("hex");
      return uploadLocalFile({
        remote: {
          put: async (key, filePath) => {
            await client.put(key, filePath);
            return { mode: "put", attempts: [{ attempt: 1, status: "success" }] };
          },
          multipart: (options) => multipartUploadWithCheckpoint({
            client,
            sha256: object.sha256,
            ...options,
          }),
        },
        key: object.key,
        filePath: object.filePath,
        size: object.size,
        checkpointPath: path.join(checkpointRoot, `${checkpointName}.json`),
      });
    },
    readback,
  };
}

function requiredEnvironment(environment, name) {
  const value = String(environment[name] ?? "").trim();
  if (!value) fail(`本地环境变量 ${name} 缺失`);
  return value;
}

/** OSS 凭据只从当前本地进程环境读取，调用方不得记录返回对象。 */
export async function createAliOssClientFromEnvironment(environment = process.env) {
  const { default: OSS } = await import("ali-oss");
  return new OSS({
    accessKeyId: requiredEnvironment(environment, "OSS_ACCESS_KEY_ID"),
    accessKeySecret: requiredEnvironment(environment, "OSS_ACCESS_KEY_SECRET"),
    bucket: requiredEnvironment(environment, "OSS_BUCKET"),
    endpoint: requiredEnvironment(environment, "OSS_ENDPOINT"),
    region: String(environment.OSS_REGION ?? "").trim() || undefined,
    stsToken: String(environment.OSS_STS_TOKEN ?? "").trim() || undefined,
    secure: true,
    timeout: "10m",
    retryMax: 0,
  });
}

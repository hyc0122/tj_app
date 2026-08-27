import fs from "node:fs";
import path from "node:path";

import {
  PUBLIC_REPOSITORY,
  exactExpectedNames,
  validateRelayProvenance,
  verifyDownloadedPublication,
} from "./release-relay-contract.mjs";

const API_ROOT = "https://api.github.com";

function fail(message) {
  throw new Error(`GitHub Release 下载失败：${message}`);
}

function headers(token, accept = "application/vnd.github+json") {
  const value = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "tianjiang-release-relay",
  };
  if (token) value.Authorization = `Bearer ${token}`;
  return value;
}

function canonicalReleaseAssetName(asset) {
  // GitHub 可能截短包含中文的 name；非空 label 保留云端构建时的完整原始文件名。
  return typeof asset?.label === "string" && asset.label.length > 0
    ? asset.label
    : asset?.name;
}

async function requestJson(fetchImpl, endpoint, token) {
  const response = await fetchImpl(`${API_ROOT}${endpoint}`, { headers: headers(token) });
  if (!response.ok) fail(`GitHub API HTTP ${response.status}：${endpoint}`);
  return response.json();
}

async function requestBytes(fetchImpl, url, token) {
  const response = await fetchImpl(url, { headers: headers(token, "application/octet-stream") });
  if (!response.ok) fail(`Release Asset HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function decodePackageVersion(contentResponse) {
  if (contentResponse?.encoding !== "base64" || typeof contentResponse.content !== "string") {
    fail("Run Commit 的根 package.json 响应无效");
  }
  let document;
  try {
    document = JSON.parse(Buffer.from(contentResponse.content.replaceAll("\n", ""), "base64").toString("utf8"));
  } catch {
    fail("Run Commit 的根 package.json 不能解析");
  }
  if (typeof document.version !== "string") fail("Run Commit 的根 package.json.version 缺失");
  return document.version;
}

function tagForChannel(version, channel) {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const beta = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;
  const valid = channel === "stable" ? stable.test(version) : channel === "beta" && beta.test(version);
  if (!valid) fail(`${channel} 渠道与根 package.json.version 不一致`);
  return `v${version}`;
}

async function resolveTagCommit({ fetchImpl, token, tag }) {
  let object = (await requestJson(
    fetchImpl,
    `/repos/${PUBLIC_REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`,
    token,
  )).object;
  for (let depth = 0; depth < 5; depth += 1) {
    if (object?.type === "commit" && /^[a-f0-9]{40}$/.test(object.sha)) return object.sha;
    if (object?.type !== "tag" || !/^[a-f0-9]{40}$/.test(object.sha)) break;
    object = (await requestJson(
      fetchImpl,
      `/repos/${PUBLIC_REPOSITORY}/git/tags/${object.sha}`,
      token,
    )).object;
  }
  fail("Git Tag 不能解析到唯一 Commit");
}

function assertAssetList(release, manifest) {
  if (!Array.isArray(release.assets)) fail("GitHub Release assets 缺失");
  const expected = exactExpectedNames(manifest);
  const actual = release.assets
    .map(canonicalReleaseAssetName)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`GitHub Release Asset 集合存在缺失、多余或重名：${actual.join(",")}`);
  }
  const expectedSize = new Map(manifest.artifacts.map((artifact) => [artifact.releaseAsset, artifact.size]));
  for (const asset of release.assets) {
    const canonicalName = canonicalReleaseAssetName(asset);
    let downloadUrl;
    try {
      downloadUrl = new URL(asset.browser_download_url);
    } catch {
      fail(`GitHub Release Asset 下载地址无效：${asset.name}`);
    }
    if (
      downloadUrl.origin !== "https://github.com"
      || !downloadUrl.pathname.startsWith(`/${PUBLIC_REPOSITORY}/releases/download/${manifest.tag}/`)
      || path.basename(asset.name) !== asset.name
      || path.basename(canonicalName) !== canonicalName
      || (expectedSize.has(canonicalName) && expectedSize.get(canonicalName) !== asset.size)
    ) {
      fail(`GitHub Release Asset 字段或大小无效：${asset.name}`);
    }
  }
  return expected;
}

function createOrReuseDirectory(destination) {
  if (fs.existsSync(destination)) {
    const details = fs.lstatSync(destination);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      fail(`下载缓存不是普通目录：${destination}`);
    }
    if (fs.existsSync(path.join(destination, ".relay-download-failed"))) {
      fail(`下载缓存存在失败标记，拒绝作为中转来源：${destination}`);
    }
    return false;
  }
  fs.mkdirSync(destination, { recursive: true });
  return true;
}

/**
 * 以指定成功 Run 为锚点，从公开 tj_app Release 下载同 Tag 的原始资产。
 * 不下载私有主仓库，不展开 Actions Artifact，也不修改任何资产字节。
 */
export async function downloadGithubReleaseForRun({
  runId,
  channel,
  destinationRoot,
  fetchImpl = fetch,
  token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "",
  verifyPublication = verifyDownloadedPublication,
}) {
  const normalizedRunId = String(runId ?? "").trim();
  if (!/^\d+$/.test(normalizedRunId)) fail("--run-id 必须是十进制 GitHub Actions Run ID");
  if (channel !== "stable" && channel !== "beta") fail("--channel 只允许 stable 或 beta");

  const run = await requestJson(
    fetchImpl,
    `/repos/${PUBLIC_REPOSITORY}/actions/runs/${normalizedRunId}`,
    token,
  );
  // 在接触 Release 资产前先关闭失败、取消、进行中的 Run。
  if (run.status !== "completed" || run.conclusion !== "success") {
    fail("指定 GitHub Actions Run 的最终状态必须是 completed/success");
  }
  const packageResponse = await requestJson(
    fetchImpl,
    `/repos/${PUBLIC_REPOSITORY}/contents/package.json?ref=${encodeURIComponent(run.head_sha)}`,
    token,
  );
  const remotePackageVersion = decodePackageVersion(packageResponse);
  const tag = tagForChannel(remotePackageVersion, channel);
  const resolvedTagCommit = await resolveTagCommit({ fetchImpl, token, tag });
  const release = await requestJson(
    fetchImpl,
    `/repos/${PUBLIC_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`,
    token,
  );
  const manifestAsset = release.assets?.find(
    (asset) => canonicalReleaseAssetName(asset) === "release-manifest.json",
  );
  if (!manifestAsset) fail("GitHub Release 缺少 release-manifest.json");
  const manifestBytes = await requestBytes(fetchImpl, manifestAsset.browser_download_url, token);
  if (manifestBytes.length !== manifestAsset.size) fail("release-manifest.json 下载大小不一致");
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    fail("release-manifest.json 不能解析");
  }
  const context = validateRelayProvenance({
    requestedRunId: normalizedRunId,
    requestedChannel: channel,
    run,
    manifest,
    remotePackageVersion,
    resolvedTagCommit,
    release,
  });
  const expectedNames = assertAssetList(release, manifest);

  const destination = path.join(
    path.resolve(destinationRoot),
    `run-${normalizedRunId}-${channel}-${manifest.version}`,
  );
  const created = createOrReuseDirectory(destination);
  try {
    if (created) {
      for (const assetName of expectedNames) {
        const asset = release.assets.find(
          (entry) => canonicalReleaseAssetName(entry) === assetName,
        );
        const bytes = assetName === "release-manifest.json"
          ? manifestBytes
          : await requestBytes(fetchImpl, asset.browser_download_url, token);
        if (bytes.length !== asset.size) fail(`Release Asset 下载大小不一致：${assetName}`);
        fs.writeFileSync(path.join(destination, assetName), bytes, { flag: "wx" });
      }
    }
    // 重试只复用经过完整再校验的只读缓存，不能凭目录存在就信任本地字节。
    const verification = await verifyPublication({ directory: destination, manifest });
    return {
      directory: destination,
      context,
      manifest,
      verification,
      releaseUrl: release.html_url,
      release,
      run,
    };
  } catch (error) {
    // 下载失败目录可能用于诊断，但不得被后续中转误用；显式标记失败而不自动删除证据。
    if (created) {
      fs.writeFileSync(path.join(destination, ".relay-download-failed"), `${error.message}\n`, { flag: "w" });
    }
    throw error;
  }
}

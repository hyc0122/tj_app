import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const SAFE_RUN_CONCLUSIONS = new Set(["failure", "success"]);
const MAX_TAG_DEPTH = 8;

function fail(reason) {
  throw new Error(`Windows Beta 来源核验失败：${reason}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireSha(value, label) {
  if (typeof value !== "string" || !SHA.test(value)) fail(`${label}不是 40 位小写 Git SHA`);
  return value;
}

function requireId(value, label) {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) fail(`${label}无效`);
  return text;
}

function resolveTagCommit(tagRef, tagObjects, expectedCommitSha) {
  if (!isObject(tagRef?.object) || !isObject(tagObjects)) fail("Tag ref 证据无效");
  let current = tagRef.object;
  const seen = new Set();
  for (let depth = 0; depth <= MAX_TAG_DEPTH; depth += 1) {
    const objectSha = requireSha(current.sha, "Tag 对象 SHA");
    if (current.type === "commit") {
      if (objectSha !== expectedCommitSha) fail("Tag 最终提交发生漂移");
      return objectSha;
    }
    if (current.type !== "tag") fail(`Tag 对象类型 ${String(current.type)} 不受支持`);
    if (seen.has(objectSha)) fail("Tag 解引用出现循环");
    seen.add(objectSha);
    const tagObject = tagObjects[objectSha];
    if (!isObject(tagObject) || tagObject.sha !== objectSha || !isObject(tagObject.object)) {
      fail("Tag 注释对象缺失或与请求 SHA 漂移");
    }
    current = tagObject.object;
  }
  fail("Tag 解引用层级超过安全上限");
}

function verifyRun(run, expected) {
  if (!isObject(run)) fail("run 证据无效");
  if (requireId(run.id, "run ID") !== expected.runId) fail("run ID 漂移");
  if (run.head_sha !== expected.commitSha || run.event !== "push") fail("run 提交或事件漂移");
  if (run.status !== "completed") fail("run 尚未完成或状态异常");
  // 恢复发布允许整体矩阵失败，但取消、超时等非确定性结论必须失败关闭。
  if (!SAFE_RUN_CONCLUSIONS.has(run.conclusion)) fail(`run 结论 ${String(run.conclusion)} 不可用于恢复`);
}

function verifyJob(jobs, expected) {
  if (!Array.isArray(jobs?.jobs)) fail("jobs 证据无效");
  const matched = jobs.jobs.filter((job) => String(job?.id ?? "") === expected.jobId);
  if (matched.length !== 1) fail("Windows job 必须唯一且不得缺失");
  const [job] = matched;
  if (job.status !== "completed" || job.conclusion !== "success") fail("Windows job 未成功完成");
  if (typeof job.name !== "string" || !job.name.includes("windows-x64")) fail("Windows job 名称漂移");
}

function verifyArtifact(artifacts, expected) {
  if (!Array.isArray(artifacts?.artifacts)) fail("Artifact 证据无效");
  const matched = artifacts.artifacts.filter((artifact) => artifact?.name === expected.artifactName);
  if (matched.length !== 1) fail("Windows Artifact 必须按名称唯一");
  const [artifact] = matched;
  if (String(artifact.id ?? "") !== expected.artifactId) fail("Windows Artifact ID 漂移");
  if (artifact.expired !== false) fail("Windows Artifact 已过期或可用状态未知");
}

function validateExpected(expected) {
  if (!isObject(expected)) fail("固定来源上下文无效");
  requireSha(expected.commitSha, "候选提交");
  for (const [key, label] of [["runId", "run ID"], ["jobId", "job ID"], ["artifactId", "Artifact ID"]]) {
    expected[key] = requireId(expected[key], label);
  }
  if (expected.artifactName !== "windows-x64") fail("Artifact 名称必须是 windows-x64");
  return expected;
}

export function verifyWindowsRecoverySourceEvidence({ tagRef, tagObjects, run, jobs, artifacts, expected }) {
  const fixed = validateExpected({ ...expected });
  const commitSha = resolveTagCommit(tagRef, tagObjects, fixed.commitSha);
  verifyRun(run, fixed);
  verifyJob(jobs, fixed);
  verifyArtifact(artifacts, fixed);
  return { commitSha, runConclusion: run.conclusion };
}

async function fetchJson(apiPath, token, repository) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${apiPath}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) fail(`GitHub API ${apiPath} 返回 HTTP ${response.status}`);
  return response.json();
}

function writeEvidence(directory, name, value) {
  fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

async function main() {
  const token = process.env.GH_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const tag = process.env.RECOVERY_TAG;
  if (!token || !repository || !tag) fail("GitHub token、仓库或恢复 Tag 缺失");
  const expected = validateExpected({
    commitSha: process.env.SOURCE_COMMIT_SHA,
    runId: process.env.SOURCE_RUN_ID,
    jobId: process.env.SOURCE_JOB_ID,
    artifactName: process.env.SOURCE_ARTIFACT_NAME,
    artifactId: process.env.SOURCE_ARTIFACT_ID,
  });
  const directory = path.resolve(".local/windows-recovery-api");
  fs.mkdirSync(directory, { recursive: true });
  const tagRef = await fetchJson(`git/ref/tags/${encodeURIComponent(tag)}`, token, repository);
  const tagObjects = {};
  let current = tagRef.object;
  const fetched = new Set();
  for (let depth = 0; current?.type === "tag" && depth <= MAX_TAG_DEPTH; depth += 1) {
    const sha = requireSha(current.sha, "Tag 对象 SHA");
    if (fetched.has(sha)) fail("Tag 解引用出现循环");
    fetched.add(sha);
    const tagObject = await fetchJson(`git/tags/${sha}`, token, repository);
    tagObjects[sha] = tagObject;
    current = tagObject.object;
  }
  const [run, jobs, artifacts] = await Promise.all([
    fetchJson(`actions/runs/${expected.runId}`, token, repository),
    fetchJson(`actions/runs/${expected.runId}/jobs?filter=all&per_page=100`, token, repository),
    fetchJson(`actions/runs/${expected.runId}/artifacts?per_page=100`, token, repository),
  ]);
  verifyWindowsRecoverySourceEvidence({ tagRef, tagObjects, run, jobs, artifacts, expected });
  writeEvidence(directory, "tag.json", tagRef);
  writeEvidence(directory, "tag-objects.json", tagObjects);
  writeEvidence(directory, "run.json", run);
  writeEvidence(directory, "jobs.json", jobs);
  writeEvidence(directory, "artifacts.json", artifacts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertRelaySourceBoundary,
  readRelaySources,
} from "./release-relay-contract.mjs";
import { downloadGithubReleaseForRun } from "./release-relay-github.mjs";
import {
  createAliOssClientFromEnvironment,
  createAliOssRemote,
  createOssPublicationPlan,
  publishPlanToOss,
} from "./release-relay-oss.mjs";

function fail(message) {
  throw new Error(`release:relay:oss 参数或执行失败：${message}`);
}

function parseOption(argumentsList, index) {
  const current = argumentsList[index];
  if (current.includes("=")) {
    const [name, ...rest] = current.split("=");
    return { name, value: rest.join("="), consumed: 1 };
  }
  return { name: current, value: argumentsList[index + 1], consumed: 2 };
}

export function parseRelayArguments(argumentsList) {
  const values = {};
  for (let index = 0; index < argumentsList.length;) {
    const option = parseOption(argumentsList, index);
    if (option.name !== "--run-id" && option.name !== "--channel") {
      fail(`未知参数：${option.name}`);
    }
    if (!option.value || option.value.startsWith("--")) fail(`${option.name} 缺少值`);
    if (Object.hasOwn(values, option.name)) fail(`${option.name} 重复`);
    values[option.name] = option.value;
    index += option.consumed;
  }
  const runId = String(values["--run-id"] ?? "").trim();
  const channel = String(values["--channel"] ?? "").trim();
  if (!/^\d+$/.test(runId)) fail("--run-id 必须是十进制 GitHub Actions Run ID");
  if (channel !== "stable" && channel !== "beta") fail("--channel 只允许 stable 或 beta");
  return { runId, channel };
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "w" });
  fs.renameSync(temporary, filePath);
}

function defaultWorkspaceRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function defaultSourceBoundary() {
  const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
  assertRelaySourceBoundary(readRelaySources(scriptRoot));
}

/**
 * 本地电脑唯一发布职责：下载云端正式产物、验证、原样上传 OSS、回读后更新指针。
 * 该函数没有任何构建、签名、压缩或子进程依赖。
 */
export async function relayReleaseToOss({
  runId,
  channel,
  platform = process.platform,
  workspaceRoot = defaultWorkspaceRoot(),
  environment = process.env,
  dependencies = {},
}) {
  if (platform !== "win32") fail("本地 OSS 中转只允许在 Windows 电脑执行");
  const assertSourceBoundary = dependencies.assertSourceBoundary ?? defaultSourceBoundary;
  const download = dependencies.download ?? downloadGithubReleaseForRun;
  const createClient = dependencies.createClient ?? createAliOssClientFromEnvironment;
  const createRemote = dependencies.createRemote ?? createAliOssRemote;
  const createPlan = dependencies.createPlan ?? createOssPublicationPlan;
  const publish = dependencies.publish ?? publishPlanToOss;

  // 任何网络或凭据访问前，先关闭本地构建/重签名/重打包执行面。
  await assertSourceBoundary();
  const relayRoot = path.join(path.resolve(workspaceRoot), ".local", "release-relay");
  const downloaded = await download({
    runId,
    channel,
    destinationRoot: path.join(relayRoot, "downloads"),
    token: environment.GH_TOKEN ?? environment.GITHUB_TOKEN ?? "",
  });
  const client = await createClient(environment);
  const checkpointRoot = path.join(relayRoot, "checkpoints", `run-${runId}-${channel}`);
  const remote = createRemote({ client, checkpointRoot });
  const plan = createPlan({
    directory: downloaded.directory,
    manifest: downloaded.manifest,
    verifiedFiles: downloaded.verification.verified,
  });
  const publication = await publish({ plan, remote });
  if (!publication.pointersPublished) fail("渠道指针未完成，不能声明发布成功");

  const reportPath = path.join(relayRoot, "reports", `run-${runId}-${channel}.json`);
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    command: `yarn.cmd release:relay:oss --run-id ${runId} --channel ${channel}`,
    repository: downloaded.context.repository,
    workflowRunId: downloaded.context.runId,
    workflowRunUrl: downloaded.run?.html_url ?? null,
    releaseUrl: downloaded.releaseUrl,
    version: downloaded.context.version,
    tag: downloaded.context.tag,
    channel: downloaded.context.channel,
    commitSha: downloaded.context.commitSha,
    downloadDirectory: downloaded.directory,
    downloadedFiles: downloaded.verification.files.map((file) => ({
      name: file.name,
      size: file.size,
      sha256: file.sha256,
    })),
    ossPublication: publication,
    localBuildExecuted: false,
    localSigningExecuted: false,
    localRepackExecuted: false,
    reportPath,
  };
  writeJsonAtomic(reportPath, report);
  return report;
}

async function main() {
  const options = parseRelayArguments(process.argv.slice(2));
  const report = await relayReleaseToOss(options);
  console.log(`OSS 中转完成：${report.tag} / ${report.commitSha}`);
  console.log(`GitHub Release：${report.releaseUrl}`);
  console.log(`本地报告：${report.reportPath}`);
}

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) {
  main().catch((error) => {
    console.error(error?.message ?? "本地 OSS 中转失败");
    process.exitCode = 1;
  });
}

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createPlatformOssRemoteFromEnvironment,
  publishStableWindowsTransaction,
} from "./publish-platform-release-transaction.mjs";

/** GitHub Actions 入口只输出固定发布摘要，绝不输出 OSS 配置、凭据或响应正文。 */
export async function runPlatformReleaseCli({
  argv = process.argv.slice(2),
  environment = process.env,
  createRemote = createPlatformOssRemoteFromEnvironment,
} = {}) {
  const [publicationRoot, version] = argv;
  if (!publicationRoot || !version || argv.length !== 2) {
    throw new Error("用法: node publish-platform-release-cli.mjs <publicationRoot> <version>");
  }
  const remote = await createRemote(environment);
  const result = await publishStableWindowsTransaction({
    publicationRoot,
    version,
    remote,
    singleWriterProof: environment.TIANJIANG_RELEASE_SINGLE_WRITER,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

function safeCliError(error) {
  const message = error instanceof Error ? error.message : "未知错误";
  if (/^(?:用法:|Stable Windows 远端发布失败：OSS (?:发布配置缺失|Region|Endpoint|公开下载地址))/.test(message)) {
    return message;
  }
  return "Stable Windows 远端阶段失败；未输出配置值、凭据或响应正文";
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  void runPlatformReleaseCli().catch((error) => {
    process.stderr.write(`[平台发布事务] ${safeCliError(error)}\n`);
    process.exitCode = 1;
  });
}

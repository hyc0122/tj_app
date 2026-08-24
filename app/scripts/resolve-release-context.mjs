import fs from "node:fs";
import { fileURLToPath } from "node:url";

const BETA_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * 统一冻结发布渠道：只允许与 package.json 逐字一致的正式版或 beta.N Tag。
 */
export function resolveReleaseContext(refType, refName, packageVersion) {
  if (refType !== "tag" || typeof packageVersion !== "string") throw new Error("只允许发布 Tag");
  if (refName !== `v${packageVersion}`) {
    throw new Error("Tag 版本与 package.json 不一致");
  }

  if (STABLE_SEMVER.test(packageVersion)) {
    return {
      version: packageVersion,
      tag: refName,
      channel: "stable",
      prerelease: false,
    };
  }
  if (!BETA_SEMVER.test(packageVersion)) throw new Error("只允许正式版或 beta.N Tag");

  return {
    version: packageVersion,
    tag: refName,
    channel: "beta",
    prerelease: true,
  };
}

function runCLI() {
  const [refType, refName, packageVersion] = process.argv.slice(2);
  const context = resolveReleaseContext(refType, refName, packageVersion);
  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    process.stdout.write(`${JSON.stringify(context)}\n`);
    return;
  }
  // 只向 GitHub Actions 输出非敏感、已验证的发布上下文。
  fs.appendFileSync(output, [
    `version=${context.version}`,
    `tag=${context.tag}`,
    `channel=${context.channel}`,
    `prerelease=${String(context.prerelease)}`,
    "",
  ].join("\n"), "utf8");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCLI();
}

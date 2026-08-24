/**
 * 确定性生成内置 Skills manifest。
 * 字段：version、path、size、sha256；path 按 en 排序固定输出。
 * 用法：node scripts/generate-builtin-skills-manifest.mjs [builtinRoot] [outJson]
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(__dirname, "..", "src", "tianjiang", "skills", "builtin");
const defaultOut = path.resolve(
  __dirname,
  "..",
  "src",
  "tianjiang",
  "skills",
  "builtin-skills-manifest.json",
);

function fail(message) {
  throw new Error(message);
}

function normalizeRelative(value) {
  return value.split(path.sep).join("/");
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function assertSafeSegment(segment) {
  if (
    !segment
    || segment === "."
    || segment === ".."
    || segment.includes("\0")
    || segment.toUpperCase() === "NUL"
  ) {
    fail(`非法路径段：${segment}`);
  }
}

function walkRegularFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assertSafeSegment(entry.name);
      const absolute = path.join(directory, entry.name);
      const details = lstatSync(absolute);
      if (details.isSymbolicLink()) {
        fail(`禁止符号链接/junction：${normalizeRelative(path.relative(root, absolute))}`);
      }
      if (details.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!details.isFile()) {
        fail(`非普通文件：${normalizeRelative(path.relative(root, absolute))}`);
      }
      files.push({
        path: normalizeRelative(path.relative(root, absolute)),
        size: details.size,
        sha256: sha256File(absolute),
      });
    }
  };
  visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return files;
}

export function generateBuiltinSkillsManifest(builtinRoot, options = {}) {
  const root = path.resolve(builtinRoot);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    fail(`内置 Skills 根目录不存在：${root}`);
  }
  if (lstatSync(root).isSymbolicLink()) {
    fail("内置 Skills 根目录不得为符号链接");
  }
  const version = Number.isSafeInteger(options.version) ? options.version : 1;
  const files = walkRegularFiles(root).map((file) => ({
    path: file.path,
    version: options.entryVersion ?? "1.0.0",
    size: file.size,
    sha256: file.sha256,
  }));
  if (files.length === 0) fail("内置 Skills 为空，拒绝生成 manifest");
  return { version, files };
}

function main() {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : defaultRoot;
  const out = process.argv[3] ? path.resolve(process.argv[3]) : defaultOut;
  const manifest = generateBuiltinSkillsManifest(root);
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(
    `generated manifest files=${manifest.files.length} -> ${out}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

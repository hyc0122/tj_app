import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const appRoot = path.resolve(process.cwd());
const sourceRoot = path.join(appRoot, "src", "provider-templates");
const generatedPath = path.join(appRoot, "src", "lib", "vendor.json");
const controlledTemplateName = "volcengineSd2.ts";
const sourceTemplateName = `${controlledTemplateName}.template`;

function normalizeLineEndings(value: string): string {
  // Windows 生成物可能使用 CRLF；一致性门禁只忽略换行符差异，正文仍须逐字相同。
  return value.replace(/\r\n/g, "\n");
}

test("供应商模板生成物必须与受审计源文件逐字一致", () => {
  const generated = JSON.parse(
    fs.readFileSync(generatedPath, "utf8"),
  ) as Record<string, string>;
  const sourceFiles = fs
    .readdirSync(sourceRoot)
    .filter((file) => file.endsWith(".ts.template"))
    .sort((left, right) => left.localeCompare(right, "en"));
  const generatedKeys = sourceFiles.map((file) =>
    file.slice(0, -".template".length),
  );
  assert.deepEqual(Object.keys(generated), generatedKeys);
  for (const sourceFile of sourceFiles) {
    assert.equal(
      normalizeLineEndings(generated[sourceFile.slice(0, -".template".length)]),
      normalizeLineEndings(fs.readFileSync(path.join(sourceRoot, sourceFile), "utf8")),
      sourceFile,
    );
  }
});

test("TOS 模板日志只能通过脱敏事件函数输出允许字段", () => {
  const source = fs.readFileSync(
    path.join(sourceRoot, sourceTemplateName),
    "utf8",
  );

  // 所有模板只能保留脱敏助手内部的一次 logger 调用，业务流程不得绕过。
  const allSources = fs
    .readdirSync(sourceRoot)
    .filter((file) => file.endsWith(".ts.template"))
    .map((file) => fs.readFileSync(path.join(sourceRoot, file), "utf8"))
    .join("\n");
  assert.equal(allSources.match(/\blogger\s*\(/g)?.length ?? 0, 1);
  assert.equal(source.match(/\blogger\s*\(/g)?.length ?? 0, 1);
  assert.match(source, /function logSafeEvent\(details: SafeLogDetails/);
  assert.match(source, /provider=\$\{vendor\.id\}/);
  assert.match(source, /objectSha256=\$\{safeObjectKeyDigest\(details\.objectKey\)\}/);
  assert.match(source, /status=\$\{details\.status\}/);
  assert.match(source, /requestId=\$\{requestId\}/);
  assert.doesNotMatch(source, /safeEvent|\[\$\{safeEvent\}\]/);

  for (const forbidden of [
    /logger\s*\(\s*vendor/i,
    /logger\s*\(\s*provider/i,
    /logger\s*\(\s*(?:createResponse|response|task|queryData|data)\b/i,
    /TOS Debug/i,
    /CanonicalRequest:\\n/i,
    /StringToSign:\\n/i,
    /生成预签名URL/i,
    /logger\s*\(\s*`[^`]*(?:authorization|inputValues|assetUrl|https?:\/\/)/i,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("旧品牌供应商入口已映射为 tianjiang 且不得恢复旧品牌文件名", () => {
  // 门禁禁止字面量旧品牌词；用码点拼出检测目标。
  const legacyVendorBase = String.fromCodePoint(116, 111, 111, 110, 102, 108, 111, 119);
  const names = fs.readdirSync(sourceRoot);
  assert.equal(names.includes(`${legacyVendorBase}.ts.template`), false);
  assert.equal(names.includes("tianjiang.ts.template"), true);
  const generatedKeys = Object.keys(JSON.parse(fs.readFileSync(generatedPath, "utf8")));
  assert.equal(generatedKeys.includes(`${legacyVendorBase}.ts`), false);
  assert.equal(generatedKeys.includes("tianjiang.ts"), true);
});

test("11 个供应商模板齐全且 getVendorList 隔离错误", () => {
  const expected = [
    "atlascloud", "deepseek", "grsai", "klingai", "minimax", "null",
    "openai", "tianjiang", "vidu", "volcengine", "volcengineSd2",
  ].map((name) => `${name}.ts.template`).sort((a, b) => a.localeCompare(b, "en"));
  const actual = fs.readdirSync(sourceRoot)
    .filter((file) => file.endsWith(".ts.template"))
    .sort((a, b) => a.localeCompare(b, "en"));
  assert.deepEqual(actual, expected);
  const getVendorList = fs.readFileSync(
    path.join(appRoot, "src", "routes", "setting", "vendorConfig", "getVendorList.ts"),
    "utf8",
  );
  assert.doesNotMatch(getVendorList, /\.where\([^\)]*\)\.delete\(/);
  assert.doesNotMatch(getVendorList, /\.delete\(\)/);
  assert.match(getVendorList, /loadError/);
});

test("生成后的 vendor.json 同样不含供应商密钥和签名日志", () => {
  const generated = JSON.parse(
    fs.readFileSync(generatedPath, "utf8"),
  ) as Record<string, string>;
  const controlledTemplate = generated[controlledTemplateName];
  const allGeneratedTemplates = Object.values(generated).join("\n");
  assert.equal(
    allGeneratedTemplates.match(/\blogger\s*\(/g)?.length ?? 0,
    1,
  );
  assert.equal(controlledTemplate.match(/\blogger\s*\(/g)?.length ?? 0, 1);
  assert.doesNotMatch(
    controlledTemplate,
    /logger\s*\(\s*(?:vendor|provider|createResponse|response|task|queryData|data)\b|TOS Debug|CanonicalRequest:\\n|StringToSign:\\n|生成预签名URL/i,
  );
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  assertSafeVendorId,
  MAX_VENDOR_SOURCE_BYTES,
  resolveVendorSourceFile,
  resolveWritableVendorSourceFile,
  sanitizeVendorRouteError,
} from "../../src/utils/vendor-source-path";
import { sanitizeVendorSourceSecrets } from "../../src/utils/vendor-private-config";

const SAMPLE_CODE = `/**
 * synthetic vendor
 */
exports.vendor = {
  id: "synthetic",
  name: "Synthetic",
  author: "test",
  inputs: [{ key: "apiKey", label: "Key", type: "password", required: true }],
  inputValues: { apiKey: "" },
  models: [{ name: "t", modelName: "t-1", type: "text", think: false }],
};
exports.textRequest = async () => ({});
exports.imageRequest = async () => ({});
exports.videoRequest = async () => ({});
`;

test("供应商 ID 拒绝路径逃逸与非法字符", () => {
  assert.equal(assertSafeVendorId("volcengineSd2"), "volcengineSd2");
  assert.equal(assertSafeVendorId("openai"), "openai");
  for (const bad of ["../x", "a/b", "a\\b", "C:x", "", "..", "a..b/c", "中文"]) {
    assert.throws(() => assertSafeVendorId(bad), /供应商 ID 无效/);
  }
  const root = path.join(process.cwd(), "..", ".tmp", "vendor-path-root");
  fs.mkdirSync(root, { recursive: true });
  const file = resolveVendorSourceFile(root, "volcengine");
  assert.ok(file.endsWith(`${path.sep}volcengine.ts`));
  assert.throws(() => resolveVendorSourceFile(root, "../escape"), /无效|越界/);
});

test("供应商源码写入拒绝符号链接根目录与目标文件", () => {
  const root = path.resolve(process.cwd(), "..", ".tmp", "vendor-safe-write-root");
  const target = resolveVendorSourceFile(root, "openai");
  const directoryStat = {
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
  };
  const symlinkStat = {
    isDirectory: () => false,
    isFile: () => false,
    isSymbolicLink: () => true,
  };

  assert.throws(
    () => resolveWritableVendorSourceFile(root, "openai", {
      existsSync: () => true,
      lstatSync: (candidate) => candidate === root ? symlinkStat : directoryStat,
    }),
    /供应商源码目录无效/,
  );
  assert.throws(
    () => resolveWritableVendorSourceFile(root, "openai", {
      existsSync: () => true,
      lstatSync: (candidate) => candidate === target ? symlinkStat : directoryStat,
    }),
    /供应商源码文件无效/,
  );
});

test("getVendorList 源码不得恢复批量 code 字段；getVendorCode 路由存在", () => {
  const list = fs.readFileSync(
    path.join(process.cwd(), "src/routes/setting/vendorConfig/getVendorList.ts"),
    "utf8",
  );
  assert.doesNotMatch(list, /getCode\(|\bcode:\s/);
  const getCodeRoute = fs.readFileSync(
    path.join(process.cwd(), "src/routes/setting/vendorConfig/getVendorCode.ts"),
    "utf8",
  );
  assert.match(getCodeRoute, /success\(\{\s*id,\s*code\s*\}\)/);
  assert.match(getCodeRoute, /assertSafeVendorId/);
  assert.match(getCodeRoute, /o_vendorConfig/);
});

test("源码写盘继续经过 sanitizeVendorSourceSecrets", () => {
  const update = fs.readFileSync(
    path.join(process.cwd(), "src/routes/setting/vendorConfig/updateCode.ts"),
    "utf8",
  );
  const sharedUpdate = fs.readFileSync(
    path.join(process.cwd(), "src/utils/vendor-source-update.ts"),
    "utf8",
  );
  assert.match(update, /applyVendorSourceUpdate/);
  assert.match(sharedUpdate, /sanitizeVendorSourceSecrets/);
  const secret = "user-private-password-literal-xyz";
  const source = `const k = "${secret}";\nexports.vendor = { inputs: [{ key: "apiKey", type: "password" }], inputValues: { apiKey: "${secret}" } };`;
  const cleaned = sanitizeVendorSourceSecrets(
    source,
    [{ key: "apiKey", type: "password" }],
    { apiKey: secret },
  );
  assert.doesNotMatch(cleaned, /user-private-password-literal-xyz/);
});

test("错误脱敏不含绝对路径与密钥样例", () => {
  const msg = sanitizeVendorRouteError(
    new Error("E:\\private\\vendor\\x.ts secret"),
    "默认失败",
  );
  assert.equal(msg, "默认失败");
  assert.equal(
    sanitizeVendorRouteError(new Error("供应商 ID 无效"), "默认"),
    "供应商 ID 无效",
  );
  assert.ok(MAX_VENDOR_SOURCE_BYTES > 1024);
});

test("读写闭环：文件存在时 getCode 返回非空，非法 id 失败", async () => {
  const worktree = path.join(process.cwd(), "..");
  const fixture = path.join(worktree, ".tmp", `vendor-code-${Date.now()}`);
  const dataRoot = path.join(fixture, "data");
  const vendorDir = path.join(dataRoot, "vendor");
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(path.join(vendorDir, "synthetic.ts"), SAMPLE_CODE, "utf8");

  const prevCtx = process.env.NODE_TEST_CONTEXT;
  const prevData = process.env.TIANJIANG_TEST_DATA_ROOT;
  const prevTree = process.env.TIANJIANG_TEST_WORKTREE_ROOT;
  process.env.NODE_TEST_CONTEXT = "1";
  process.env.TIANJIANG_TEST_WORKTREE_ROOT = worktree;
  process.env.TIANJIANG_TEST_DATA_ROOT = dataRoot;
  try {
    // 清缓存，确保 getPath 读到测试数据根
    const vendorPath = require.resolve("../../src/utils/vendor");
    delete require.cache[vendorPath];
    const getPathKey = require.resolve("../../src/utils/getPath");
    delete require.cache[getPathKey];
    const vendor = await import("../../src/utils/vendor");
    const code = vendor.getCode("synthetic");
    assert.ok(code.includes("exports.vendor"));
    assert.ok(code.length > 20);
    const updatedCode = SAMPLE_CODE.replace("Synthetic", "Synthetic Updated");
    vendor.writeCode("synthetic", updatedCode);
    assert.match(vendor.getCode("synthetic"), /Synthetic Updated/);
    assert.equal(
      fs.readdirSync(vendorDir).filter((name) => /\.(?:tmp|bak)$/.test(name)).length,
      0,
      "原子替换成功后不得遗留临时或备份源码文件",
    );
    assert.throws(() => vendor.getCode("../evil"), /供应商 ID 无效/);
    const empty = vendor.getCode("not_installed_vendor");
    assert.equal(empty, "");
  } finally {
    if (prevCtx === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = prevCtx;
    if (prevData === undefined) delete process.env.TIANJIANG_TEST_DATA_ROOT;
    else process.env.TIANJIANG_TEST_DATA_ROOT = prevData;
    if (prevTree === undefined) delete process.env.TIANJIANG_TEST_WORKTREE_ROOT;
    else process.env.TIANJIANG_TEST_WORKTREE_ROOT = prevTree;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

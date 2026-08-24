const fs = require("node:fs");
const path = require("node:path");

// 该 Yarn 脚本固定从 App 根执行，CommonJS 写法同时兼容 Node 直接运行与项目 tsc。
const appRoot = path.resolve(process.cwd());
const vendorSourceDir = path.join(appRoot, "src", "provider-templates");
const vendorOutputPath = path.join(appRoot, "src", "lib", "vendor.json");
const files = fs
  .readdirSync(vendorSourceDir)
  // 使用 .template 后缀，避免模板源码被应用 TypeScript 编译器当作运行时代码。
  .filter((file: string) => file.endsWith(".ts.template"))
  .sort((left: string, right: string) => left.localeCompare(right, "en"));
const result: Record<string, string> = {};
for (const file of files) {
  // 生成物只接收当前仓库内受审计的供应商模板源文件。
  result[file.slice(0, -".template".length)] = fs.readFileSync(
    path.join(vendorSourceDir, file),
    "utf-8",
  );
}
fs.writeFileSync(vendorOutputPath, JSON.stringify(result, null, 2), "utf-8");
console.log(`Done, saved ${path.relative(appRoot, vendorOutputPath)}`);

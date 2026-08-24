import generateRouter from "../src/core";

// 标准 lint 必须在全新克隆中自行生成被 Git 忽略的受控路由表。
void generateRouter().catch((error: unknown) => {
  console.error("生成受控路由表失败", error);
  process.exitCode = 1;
});

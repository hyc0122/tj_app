/**
 * 模块悬浮覆盖清单（明确文件列表，禁止“全局正则宣称全部覆盖”）。
 * 每项断言：路径存在且包含约定的悬浮类，且不在排除控件上误用。
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** 明确覆盖清单：文件 → 期望类名 */
const COVERAGE: Array<{ file: string; className: string; note: string }> = [
  { file: "src/views/project/index.vue", className: "module-interactive", note: "本机项目卡" },
  { file: "src/views/project/components/centralCatalog.vue", className: "module-interactive", note: "云端项目卡" },
  { file: "src/views/team/index.vue", className: "module-interactive", note: "团队卡" },
  { file: "src/components/setting/components/languageConfig.vue", className: "module-interactive", note: "语言选择卡" },
  { file: "src/views/script/index.vue", className: "module-interactive", note: "剧本卡（外层）" },
  { file: "src/components/setting/components/agentConfog.vue", className: "module-interactive", note: "Agent 部署卡" },
  { file: "src/views/production/node/script.vue", className: "module-interactive--panel", note: "流程节点 script" },
  { file: "src/views/production/node/scriptPlan.vue", className: "module-interactive--panel", note: "流程节点 scriptPlan" },
  { file: "src/views/production/node/storyboardTable.vue", className: "module-interactive--panel", note: "分镜表节点" },
  { file: "src/views/production/node/storyboard.vue", className: "module-interactive--panel", note: "分镜节点" },
  { file: "src/views/production/node/poster.vue", className: "module-interactive--panel", note: "海报节点" },
  { file: "src/views/production/node/workbench.vue", className: "module-interactive", note: "工作台节点" },
  { file: "src/views/production/node/assets.vue", className: "module-interactive", note: "资产卡" },
  {
    file: "src/views/production/components/workbench/generate/components/imageSelect.vue",
    className: "module-interactive--sm",
    note: "生成资源瓦片",
  },
  { file: "src/components/setting/components/dbConfig.vue", className: "module-interactive", note: "数据库操作卡" },
  { file: "src/components/setting/components/about.vue", className: "module-interactive--panel", note: "关于面板" },
];

describe("module-interactive 覆盖清单（明确文件）", () => {
  for (const item of COVERAGE) {
    it(`${item.note}: ${item.file} 含 ${item.className}`, () => {
      const abs = path.join(root, item.file);
      expect(existsSync(abs), `缺失文件 ${item.file}`).toBe(true);
      const src = read(item.file);
      expect(src).toContain(item.className);
    });
  }

  it("剧本卡禁止父子双层 module-interactive（仅外层 transform）", () => {
    const src = read("src/views/script/index.vue");
    // 外层 scriptCard 有 module-interactive
    expect(src).toMatch(/scriptCard\s+module-interactive/);
    // 内层 t-card 不得再挂 module-interactive
    expect(src).not.toMatch(/<t-card[^>]*class="[^"]*module-interactive/);
  });

  it("全局 SCSS 对嵌套 module-interactive 取消内层 transform", () => {
    const scss = read("src/assets/main.scss");
    expect(scss).toMatch(/\.module-interactive\s+\.module-interactive/);
    expect(scss).toMatch(/transform:\s*none\s*!important/);
  });

  it("排除清单：输入/表格行/危险按钮/标题栏仍强制 transform:none", () => {
    const scss = read("src/assets/main.scss");
    expect(scss).toMatch(/\.t-input:hover/);
    expect(scss).toMatch(/\.t-table tbody tr:hover/);
    expect(scss).toMatch(/\.t-button--theme-danger:hover/);
    expect(scss).toMatch(/\.titleBar-btn:hover/);
  });
});

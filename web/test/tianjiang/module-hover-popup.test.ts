/**
 * 模块悬浮与 TDesign 下拉弹层定位契约（RED→GREEN）
 * - 禁止裸 `.t-popup` 被 transform:none !important 覆盖（Popper 依赖 transform 定位）
 * - 悬浮类不得匹配 TDesign 基础弹层/输入/表格/对话框
 * - 三类业务页（任务筛选、新建项目、Agent 配置）须保留正常 Select 使用，无逐页坐标补丁
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** 从 SCSS 中提取「含 transform: none !important」的规则块选择器文本 */
function blocksWithTransformNone(scss: string): string[] {
  const blocks: string[] = [];
  // 简易块扫描：选择器 { ... transform: none !important ... }
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scss)) !== null) {
    const selectors = m[1];
    const body = m[2];
    if (/transform\s*:\s*none\s*!important/i.test(body)) {
      blocks.push(selectors.replace(/\s+/g, " ").trim());
    }
  }
  return blocks;
}

/** 选择器列表是否把裸 .t-popup 当作目标（非后代限定如 .foo .t-popup 的内容样式除外） */
function bareTPopupTargeted(selectorText: string): boolean {
  // 拆成逗号分隔的独立选择器
  return selectorText.split(",").some((sel) => {
    const s = sel.trim();
    // 裸 .t-popup 或 .t-popup:hover 等，排除 .t-popup .something / .foo .t-popup
    if (!/(^|[\s>+~])\.t-popup(\b|:|$)/.test(s)) return false;
    // 若选择器还包含其他后代片段，如 `.t-popup .t-popup__content` 则不算「对弹层根节点强制 transform」
    const withoutPseudo = s.replace(/:[\w-]+(\([^)]*\))?/g, "").trim();
    // 仅匹配以 .t-popup 结尾或以 .t-popup 为唯一主体
    return /(^|[\s>+~])\.t-popup$/.test(withoutPseudo) || withoutPseudo === ".t-popup";
  });
}

describe("TDesign 下拉弹层：禁止全局 transform 重置破坏 Popper", () => {
  it("main.scss 不得在 transform:none!important 规则中包含裸 .t-popup", () => {
    const scss = read("src/assets/main.scss");
    const blocks = blocksWithTransformNone(scss);
    const offenders = blocks.filter(bareTPopupTargeted);
    expect(
      offenders,
      `禁止对裸 .t-popup 设置 transform:none !important，否则 Popper 弹层会落到 (0,0)。违规选择器块:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("main.scss 不得对裸 .t-popup 设置 filter:none !important（同规则块风险）", () => {
    const scss = read("src/assets/main.scss");
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    const offenders: string[] = [];
    while ((m = re.exec(scss)) !== null) {
      const selectors = m[1].replace(/\s+/g, " ").trim();
      const body = m[2];
      if (/filter\s*:\s*none\s*!important/i.test(body) && bareTPopupTargeted(selectors)) {
        // 仅当同块还有 transform:none 时视为定位风险（单独 filter 通常不致 (0,0)）
        if (/transform\s*:\s*none\s*!important/i.test(body)) {
          offenders.push(selectors);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("Electron 标题栏偏移不得用固定 top/left 给 .t-popup 打补丁", () => {
    const scss = read("src/assets/main.scss");
    // body.is-electron 块内不应出现 .t-popup { top/left }
    expect(scss).not.toMatch(/\.t-popup\s*\{[^}]*(top|left)\s*:/s);
    // 禁止全局 attach 掩盖：任务页不强制 Select attach body
    const task = read("src/views/task/index.vue");
    expect(task).not.toMatch(/attach\s*=\s*["']body["']/);
    expect(task).not.toMatch(/:attach\s*=\s*["']#app["']/);
  });
});

describe("三类页面 Select：无逐页坐标补丁，依赖 Popper", () => {
  const pages = [
    { name: "任务列表筛选", file: "src/views/task/index.vue" },
    { name: "Agent 配置模型选择", file: "src/components/setting/components/agentConfog.vue" },
  ];

  it("任务列表使用 t-select 且无绝对坐标补丁", () => {
    const src = read("src/views/task/index.vue");
    expect(src).toMatch(/<t-select/);
    expect(src).not.toMatch(/\.t-popup[^{]*\{[^}]*(top|left|margin)\s*:/s);
    expect(src).not.toMatch(/popupProps\s*:\s*\{[^}]*overlayStyle/s);
    expect(src).not.toMatch(/attach\s*=\s*["']body["']/);
  });

  it("新建项目对话框 Select 无逐页 top/left 补丁", () => {
    // 扫描 projectDialog 目录下 vue/scss
    const dir = path.join(root, "src/views/project/components/projectDialog");
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const walk = (d: string): string[] => {
      const out: string[] = [];
      for (const name of readdirSync(d)) {
        const p = path.join(d, name);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (/\.(vue|scss|css|ts)$/.test(name)) out.push(p);
      }
      return out;
    };
    const files = walk(dir);
    expect(files.length).toBeGreaterThan(0);
    let hasSelect = false;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/t-select|TSelect|modelSelect/i.test(src)) hasSelect = true;
      expect(src, f).not.toMatch(/\.t-popup[^{]*\{[^}]*(?:\btop\b|\bleft\b)\s*:/s);
      expect(src, f).not.toMatch(/attach\s*=\s*["']body["']/);
    }
    expect(hasSelect).toBe(true);
  });

  it("Agent 配置含模型选择且无 popup 坐标补丁", () => {
    const src = read("src/components/setting/components/agentConfog.vue");
    expect(src).toMatch(/modelSelect|t-select/i);
    expect(src).not.toMatch(/\.t-popup[^{]*\{[^}]*(?:\btop\b|\bleft\b)\s*:/s);
    expect(src).not.toMatch(/attach\s*=\s*["']body["']/);
  });

  it("模型映射等设置页 Select 无 attach=body 掩盖", () => {
    const modelMap = read("src/components/setting/components/modelMap.vue");
    expect(modelMap).not.toMatch(/attach\s*=\s*["']body["']/);
    expect(modelMap).not.toMatch(/\.t-popup[^{]*\{[^}]*(?:\btop\b|\bleft\b)\s*:/s);
  });

  it.each(pages)("$name 源码存在", ({ file }) => {
    expect(() => read(file)).not.toThrow();
  });
});

describe("统一悬浮类：不得匹配 TDesign 基础弹层", () => {
  it("存在显式 module-interactive 与 panel 变体，且悬浮规则不选择 .t-popup/.t-dialog/.t-select", () => {
    const scss = read("src/assets/main.scss");
    expect(scss).toContain(".module-interactive");
    expect(scss).toMatch(/\.module-interactive--panel|module-interactive-panel/);
    expect(scss).toContain("prefers-reduced-motion");
    expect(scss).toContain("translateY(-2px)");
    expect(scss).toMatch(/scale\(1\.0[12]\)/);

    // 提取 .module-interactive 主规则的选择器：不得写成 `.t-popup, .module-interactive`
    const hoverRuleMatch = scss.match(
      /\/\*\s*模块\/卡片可交互悬浮动效[\s\S]*?(?=\/\*|@media|:root|$)/,
    );
    const hoverSection = hoverRuleMatch?.[0] ?? scss;
    // 悬浮「正向」规则的选择器中不应出现裸 TDesign 弹层作为放大目标
    const positiveHover = hoverSection.match(
      /([^{}]*module-interactive[^{]*)\{[^}]*translateY[^}]*\}/g,
    );
    expect(positiveHover?.length ?? 0).toBeGreaterThan(0);
    for (const rule of positiveHover ?? []) {
      const sel = rule.split("{")[0];
      expect(sel).not.toMatch(/(^|[,])\s*\.t-popup\b/);
      expect(sel).not.toMatch(/(^|[,])\s*\.t-dialog\b/);
      expect(sel).not.toMatch(/(^|[,])\s*\.t-select\b/);
      expect(sel).not.toMatch(/(^|[,])\s*\.t-input\b/);
    }
  });

  it("业务卡片页显式使用 module-interactive（覆盖清单）", () => {
    const checks: Array<[string, string]> = [
      ["src/views/project/index.vue", "module-interactive"],
      ["src/pages/workbench/index.vue", "module-interactive"],
      ["src/components/setting/components/agentConfog.vue", "module-interactive"],
      ["src/components/setting/components/vendorConfig/components/VendorWorkspace.vue", "module-interactive"],
      ["src/views/script/index.vue", "module-interactive"],
      ["src/views/cornerScape/components/CornerScapeWorkspace.vue", "module-interactive"],
      ["src/components/setting/components/dbConfig.vue", "module-interactive"],
      ["src/views/production/node/assets.vue", "module-interactive"],
    ];
    for (const [file, token] of checks) {
      const src = read(file);
      expect(src, `${file} 应标记 ${token}`).toContain(token);
    }
  });

  it("存在 ModuleInteractive 公共组件导出显式类名", () => {
    const comp = read("src/components/ModuleInteractive.vue");
    expect(comp).toContain("module-interactive");
    expect(comp).toMatch(/panel|size/);
    // 中文注释要求
    expect(comp).toMatch(/[\u4e00-\u9fff]/);
  });
});

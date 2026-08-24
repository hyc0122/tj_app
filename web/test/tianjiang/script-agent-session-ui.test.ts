/**
 * 剧本 Agent UI / 主题 / 设置菜单 / Socket path 契约（RED→GREEN）
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("Socket Engine path 前后端一致", () => {
  it("web 与 app 均导出 /api/socket.io", () => {
    const web = read("src/utils/socket-path.ts");
    expect(web).toContain('"/api/socket.io"');
    const useChat = read("src/utils/useChat.ts");
    expect(useChat).toMatch(/path\s*:\s*ENGINE_IO_PATH/);
    const useSocket = read("src/utils/useSocket.ts");
    expect(useSocket).toMatch(/path\s*:\s*ENGINE_IO_PATH/);
  });
});

describe("剧本 Agent 设置菜单与 reconnect", () => {
  it("scriptAgent store 暴露 reconnect，页面不调用 productionAgent.reconnect", () => {
    const store = read("src/stores/scriptAgent.ts");
    expect(store).toMatch(/reconnect/);
    const page = read("src/views/scriptAgent/index.vue");
    expect(page).toContain("handleReconnect");
    expect(page).toMatch(/scriptAgent\.reconnect|workbench\.scriptAgent\.reconnect/);
    expect(page).toMatch(/clearMessageMemory|clearSummaryMemory|clearAllMemory/);
    // 禁止错误调用 productionAgent
    expect(page).not.toMatch(/productionAgentStore\(\)\.reconnect/);
    // 使用 scriptAgent reconnect
    expect(page).toMatch(/scriptAgentStore\(\)\.reconnect/);
  });

  it("设置弹层使用 placement 且 attach body 或避免裁剪，禁止 top/left 绝对补丁", () => {
    const page = read("src/views/scriptAgent/index.vue");
    expect(page).toMatch(/t-popup/);
    expect(page).toMatch(/placement=["']top/);
    expect(page).not.toMatch(/\.t-popup[^{]*\{[^}]*(?:\btop\b|\bleft\b)\s*:/s);
  });

  it("页面卸载断开 Socket 并停止生成", () => {
    const page = read("src/views/scriptAgent/index.vue");
    expect(page).toMatch(/onUnmounted|onBeforeUnmount/);
    expect(page).toMatch(/disconnect|stopGenerate/);
  });
});

describe("默认赛博朋克主题", () => {
  it("setting store 默认 mode=cyberpunk 且主色与赛博协调", () => {
    const setting = read("src/stores/setting.ts");
    expect(setting).toMatch(/mode:\s*["']cyberpunk["']/);
    expect(setting).toMatch(/primaryColor:\s*["']#[Aa]855[Ff]7["']/);
  });

  it("initTheme 在应用明显内容前可调用且不强制覆盖已持久化偏好（persist pick 含 themeSetting）", () => {
    const setting = read("src/stores/setting.ts");
    expect(setting).toContain('persist: { pick: ["otherSetting", "themeSetting", "language"] }');
    const theme = read("src/utils/theme.ts");
    expect(theme).toContain("initTheme");
  });
});

describe("设置二级菜单悬浮", () => {
  it("setting/index 菜单项使用 module-interactive--sm", () => {
    const src = read("src/components/setting/index.vue");
    expect(src).toMatch(/module-interactive--sm|module-interactive/);
    // 禁止再写一套独立 scale 动画覆盖 t-menu 根
    expect(src).not.toMatch(/\.settingMenu[^{]*\{[^}]*transform:\s*scale/s);
  });

  it("main.scss 禁止裸 .t-popup transform:none 与 reduced-motion 契约", () => {
    const scss = read("src/assets/main.scss");
    expect(scss).toContain("prefers-reduced-motion");
    // 不得在 transform:none 规则块中含裸 .t-popup
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scss)) !== null) {
      if (/transform\s*:\s*none\s*!important/i.test(m[2])) {
        const parts = m[1].split(",");
        for (const p of parts) {
          const s = p.replace(/:[\w-]+(\([^)]*\))?/g, "").trim();
          expect(s === ".t-popup" || /(^|[\s>+~])\.t-popup$/.test(s)).toBe(false);
        }
      }
    }
  });
});

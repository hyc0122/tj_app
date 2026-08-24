import settingStore from "@/stores/setting";

/** 客户端正式主题模式：auto / light / dark / cyberpunk */
export type ThemeMode = "auto" | "light" | "dark" | "cyberpunk";

/** 第三方组件可接受的基础主题（仅 light/dark） */
export type ThemeBase = "light" | "dark";

// HEX 转 HSL
const hexToHsl = (hex: string) => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return { h: 0, s: 0, l: 0 };

  const r = parseInt(result[1], 16) / 255;
  const g = parseInt(result[2], 16) / 255;
  const b = parseInt(result[3], 16) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0,
    s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
};

// HSL 转 HEX
const hslToHex = (h: number, s: number, l: number) => {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  const toHex = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

// 生成品牌色阶
const generateColorPalette = (hex: string) => {
  const { h, s, l } = hexToHsl(hex);
  const lightLevels = [97, 92, 85, 75, 62, l, Math.max(l - 12, 20), Math.max(l - 24, 15), Math.max(l - 36, 10), Math.max(l - 48, 5)];
  return lightLevels.map((level) => hslToHex(h, s, level));
};

/** 由 applyThemeColor 写入、切回 light/dark 时必须清理的动态品牌变量 */
const DYNAMIC_BRAND_VARS = [
  "--td-brand-color-1",
  "--td-brand-color-2",
  "--td-brand-color-3",
  "--td-brand-color-4",
  "--td-brand-color-5",
  "--td-brand-color-6",
  "--td-brand-color-7",
  "--td-brand-color-8",
  "--td-brand-color-9",
  "--td-brand-color-10",
  "--td-brand-color",
  "--td-brand-color-hover",
  "--td-brand-color-focus",
  "--td-brand-color-active",
  "--td-brand-color-disabled",
  "--td-brand-color-light",
  "--td-brand-color-light-hover",
  "--td-text-color-brand",
  "--td-text-color-link",
] as const;

/**
 * 解析为 light/dark 基础层。
 * cyberpunk 正式映射为 dark，供 TDesign / Markdown / Monaco 等仅支持双主题的组件使用。
 */
export const resolveThemeBase = (mode: string): ThemeBase => {
  if (mode === "cyberpunk") return "dark";
  if (mode === "auto") {
    if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }
    return "light";
  }
  return mode === "dark" ? "dark" : "light";
};

/** 当前是否为赛博朋克显式模式（非 auto 解析结果） */
export const isCyberpunkMode = (mode: string): boolean => mode === "cyberpunk";

/**
 * Markdown 编辑器主题：只允许 light/dark。
 * auto 返回 undefined，由 md-editor 跟随系统；cyberpunk → dark。
 */
export const resolveMdEditorTheme = (mode: string): ThemeBase | undefined => {
  if (mode === "auto") return undefined;
  return resolveThemeBase(mode);
};

/**
 * Markdown 编辑器严格主题（部分调用点要求非 undefined）。
 * auto 解析为当前系统偏好；cyberpunk → dark。
 */
export const resolveMdEditorThemeStrict = (mode: string): ThemeBase => resolveThemeBase(mode);

/**
 * Monaco 主题映射：仅 vs / vs-dark。
 * cyberpunk 与 dark 均使用 vs-dark，禁止传入无效主题值。
 */
export const resolveMonacoTheme = (mode: string): "vs" | "vs-dark" =>
  resolveThemeBase(mode) === "dark" ? "vs-dark" : "vs";

/** 清除赛博朋克 class / 属性，避免污染浅色/深色 */
const clearCyberpunkDom = (root: HTMLElement) => {
  root.classList.remove("cyberpunk");
  root.removeAttribute("data-theme");
};

/**
 * 应用主题模式。
 * - light / dark / auto：标准双主题；切回时必须清掉 cyberpunk 痕迹
 * - cyberpunk：以 dark 为基础层，再叠加 cyberpunk class 与 data-theme
 */
export const applyThemeMode = (mode: string) => {
  const root = document.documentElement;
  const cyberpunk = isCyberpunkMode(mode);
  const base = resolveThemeBase(mode);

  // 非赛博模式时先清除 cyberpunk 标记，防止 class/属性残留
  if (!cyberpunk) {
    clearCyberpunkDom(root);
  }

  // TDesign 与历史 dark 类：仅 light/dark，cyberpunk 走 dark 基础
  if (base === "dark") {
    root.setAttribute("theme-mode", "dark");
    root.classList.add("dark");
  } else {
    root.removeAttribute("theme-mode");
    root.classList.remove("dark");
  }

  if (cyberpunk) {
    root.classList.add("cyberpunk");
    root.setAttribute("data-theme", "cyberpunk");
    // 保持 theme-mode=dark，避免第三方收到无效值
    root.setAttribute("theme-mode", "dark");
    root.classList.add("dark");
  }
};

// 应用主题色（用户自定义主色；赛博朋克默认色阶由 CSS token 提供，仍允许覆盖）
export const applyThemeColor = (color: string) => {
  const root = document.documentElement;
  const palette = generateColorPalette(color);
  // 深色与赛博朋克均使用反转色阶，保证对比
  const isDarkBase =
    root.getAttribute("theme-mode") === "dark" ||
    root.classList.contains("dark") ||
    root.classList.contains("cyberpunk");
  const colors = isDarkBase ? [...palette].reverse() : palette;

  colors.forEach((c, i) => root.style.setProperty(`--td-brand-color-${i + 1}`, c));

  ["", "-hover:5", "-focus:2", "-active:7", "-disabled:3", "-light:1", "-light-hover:2"].forEach((suffix) => {
    const [name, level] = suffix.split(":");
    root.style.setProperty(`--td-brand-color${name}`, level ? `var(--td-brand-color-${level})` : "var(--td-brand-color-6)");
  });

  root.style.setProperty("--td-text-color-brand", `var(--td-brand-color-${isDarkBase ? 8 : 7})`);
  root.style.setProperty("--td-text-color-link", "var(--td-brand-color-8)");
};

/**
 * 清除 applyThemeColor 写入的内联品牌变量，
 * 切换主题后让 CSS token（含 cyberpunk）重新接管，避免污染。
 */
export const clearDynamicBrandVars = () => {
  const root = document.documentElement;
  DYNAMIC_BRAND_VARS.forEach((name) => root.style.removeProperty(name));
};

// 使用 View Transition API 进行平滑过渡
export const toggleThemeWithTransition = (event: MouseEvent | undefined, callback: () => void) => {
  if (!document.startViewTransition) {
    callback();
    return;
  }

  const x = event?.clientX ?? window.innerWidth / 2;
  const y = event?.clientY ?? window.innerHeight / 2;
  const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

  const root = document.documentElement;
  root.style.setProperty("--x", `${x}px`);
  root.style.setProperty("--y", `${y}px`);
  root.style.setProperty("--r", `${endRadius}px`);

  document.startViewTransition(callback);
};

// 初始化主题（在 App.vue 中调用；启动时从 setting store 持久化恢复）
export const initTheme = () => {
  const { themeSetting } = storeToRefs(settingStore());
  // 应用缓存的主题设置（含 cyberpunk）
  applyThemeMode(themeSetting.value.mode);
  applyThemeColor(themeSetting.value.primaryColor);
  if (themeSetting.value.fontSize) {
    document.documentElement.style.fontSize = `${themeSetting.value.fontSize}px`;
  }

  // 监听系统主题变化（仅 auto 模式）
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (themeSetting.value.mode === "auto") {
      toggleThemeWithTransition(undefined, () => {
        // auto 下确保无 cyberpunk 残留
        clearCyberpunkDom(document.documentElement);
        const targetMode = e.matches ? "dark" : "light";

        if (targetMode === "dark") {
          document.documentElement.setAttribute("theme-mode", "dark");
          document.documentElement.classList.add("dark");
        } else {
          document.documentElement.removeAttribute("theme-mode");
          document.documentElement.classList.remove("dark");
        }

        applyThemeColor(themeSetting.value.primaryColor);
      });
    }
  });
};

// 导出 composable 供组件使用
export const useTheme = () => {
  const { themeSetting } = storeToRefs(settingStore());
  return {
    themeSetting,
    applyThemeMode,
    applyThemeColor,
    toggleThemeWithTransition,
    resolveThemeBase,
    resolveMdEditorTheme,
    resolveMdEditorThemeStrict,
    resolveMonacoTheme,
    isCyberpunkMode,
    clearDynamicBrandVars,
  };
};

import fs from "node:fs";
import path from "node:path";

const localesRoot = path.resolve("src/locales/language");
const baselineLocale = process.env.I18N_CHECK_BASELINE_LOCALE || "zh-CN";
const baseline = JSON.parse(
  fs.readFileSync(path.join(localesRoot, `${baselineLocale}.json`), "utf8"),
);
const englishPath = path.join(localesRoot, "en.json");
const english = fs.existsSync(englishPath)
  ? JSON.parse(fs.readFileSync(englishPath, "utf8"))
  : {};

for (const filename of fs.readdirSync(localesRoot).filter((name) => name.endsWith(".json"))) {
  if (filename === `${baselineLocale}.json`) continue;
  const fullPath = path.join(localesRoot, filename);
  const current = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  // 缺失翻译优先使用现有英文；英文也缺失时回退基准中文，绝不留下界面 key。
  const completed = mergeMissing(current, baseline, filename === "en.json" ? baseline : english);
  fs.writeFileSync(fullPath, `${JSON.stringify(completed, null, 2)}\n`, "utf8");
}

function mergeMissing(current, baselineValue, preferredFallback) {
  if (!isRecord(baselineValue)) return current ?? preferredFallback ?? baselineValue;
  const output = isRecord(current) ? { ...current } : {};
  for (const [key, value] of Object.entries(baselineValue)) {
    if (isRecord(value)) {
      output[key] = mergeMissing(output[key], value, preferredFallback?.[key]);
      continue;
    }
    if (!(key in output)) output[key] = preferredFallback?.[key] ?? value;
  }
  return output;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = path.join(appRoot, "build");

// 中文注释：只使用黑色与透明度，交由 macOS 在浅色/深色菜单栏中自动着色。
const templateSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">
  <path fill="#000" fill-rule="evenodd" d="M3 2.25A1.75 1.75 0 0 0 1.25 4v10A1.75 1.75 0 0 0 3 15.75h12A1.75 1.75 0 0 0 16.75 14V4A1.75 1.75 0 0 0 15 2.25H3Zm.25 1.5h2v2h-2v-2Zm0 4h2v2h-2v-2Zm0 4h2v2h-2v-2Zm4-8h3.5v10h-3.5v-10Zm5.5 0h2v2h-2v-2Zm0 4h2v2h-2v-2Zm0 4h2v2h-2v-2Z"/>
</svg>`;

const outputs = [
  { name: "trayTemplate.png", size: 18 },
  { name: "trayTemplate@2x.png", size: 36 },
];

mkdirSync(buildRoot, { recursive: true });
for (const output of outputs) {
  const target = path.join(buildRoot, output.name);
  await sharp(Buffer.from(templateSvg))
    .resize(output.size, output.size, { fit: "fill" })
    .png({ compressionLevel: 9, palette: false })
    .toFile(target);
  process.stdout.write(`[tray-template] 已生成 ${output.name} ${output.size}x${output.size}\n`);
}

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import sharp from "sharp";

const assetCases = [
  { name: "trayTemplate.png", size: 18 },
  { name: "trayTemplate@2x.png", size: 36 },
];

for (const assetCase of assetCases) {
  test(`macOS Template 图标 ${assetCase.name} 是真实单色透明 ${assetCase.size}px 资源`, async () => {
    const assetPath = path.resolve("build", assetCase.name);
    const { data, info } = await sharp(assetPath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    assert.equal(info.width, assetCase.size);
    assert.equal(info.height, assetCase.size);
    assert.equal(info.channels, 4);

    let transparentPixels = 0;
    let visiblePixels = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      const [red, green, blue, alpha] = data.subarray(offset, offset + 4);
      // Template 资源必须是中性单色，系统才能安全重着色。
      assert.equal(red, green);
      assert.equal(green, blue);
      if (alpha === 0) transparentPixels += 1;
      else visiblePixels += 1;
    }
    assert.ok(transparentPixels > 0, "图标必须含透明背景");
    assert.ok(visiblePixels > 0, "图标必须含可见图形");
  });
}

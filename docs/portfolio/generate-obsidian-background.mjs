import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const assetsDir = resolve(here, "assets");
const width = 1280;
const height = 720;
const base = [3, 5, 9];

// 每一页使用一组独立的四角配色。颜色刻意压低，背景只承担层次感，
// 不与标题、截图和正文争夺注意力。
const palettes = [
  [[20, 154, 143], [127, 104, 219], [67, 119, 190], [196, 78, 148]],
  [[197, 75, 91], [67, 130, 204], [44, 158, 139], [203, 145, 48]],
  [[116, 88, 199], [33, 152, 188], [48, 159, 146], [212, 79, 158]],
  [[48, 129, 203], [152, 91, 193], [48, 168, 138], [205, 112, 50]],
  [[179, 87, 193], [34, 145, 171], [67, 117, 204], [213, 79, 135]],
  [[193, 72, 82], [107, 99, 204], [36, 151, 156], [211, 130, 50]],
  [[39, 161, 143], [71, 115, 204], [128, 89, 202], [205, 81, 146]],
  [[200, 131, 43], [45, 145, 190], [47, 161, 133], [166, 91, 204]],
  [[37, 157, 145], [190, 80, 153], [69, 119, 204], [206, 145, 46]],
  [[54, 128, 204], [191, 79, 111], [49, 166, 141], [129, 94, 210]],
  [[205, 139, 48], [48, 150, 180], [135, 86, 202], [193, 77, 147]],
  [[192, 78, 153], [53, 151, 194], [46, 161, 136], [205, 128, 48]],
];

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

// 余弦衰减在起点和终点的斜率都为 0，颜色不会出现突变。
// 较小的椭圆半径把色彩限制在角落，不铺满四条边。
const cornerFade = (x, y, cornerX, cornerY) => {
  const dx = (x - cornerX) / 0.39;
  const dy = (y - cornerY) / 0.42;
  const distance = Math.hypot(dx, dy);
  if (distance >= 1) return 0;
  return 0.5 + 0.5 * Math.cos(Math.PI * distance);
};

const blend = (target, color, amount) => {
  const alpha = clamp(amount);
  for (let index = 0; index < 3; index += 1) {
    target[index] += (color[index] - target[index]) * alpha;
  }
};

const renderPage = async (pageIndex, palette) => {
  const pixels = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const normalizedY = y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const normalizedX = x / (width - 1);
      const pixel = [...base];
      const cornerWeights = [
        cornerFade(normalizedX, normalizedY, 0, 0),
        cornerFade(normalizedX, normalizedY, 1, 0),
        cornerFade(normalizedX, normalizedY, 0, 1),
        cornerFade(normalizedX, normalizedY, 1, 1),
      ];

      // 仅做低强度混合；每三页略有变化，让整套背景有节奏但不跳脱。
      const strength = 0.155 + (pageIndex % 3) * 0.012;
      cornerWeights.forEach((weight, cornerIndex) => {
        blend(pixel, palette[cornerIndex], weight * strength);
      });

      const offset = (y * width + x) * 4;
      pixels[offset] = Math.round(pixel[0]);
      pixels[offset + 1] = Math.round(pixel[1]);
      pixels[offset + 2] = Math.round(pixel[2]);
      pixels[offset + 3] = 255;
    }
  }

  const outputPath = resolve(assetsDir, `obsidian-page-${String(pageIndex + 1).padStart(2, "0")}.png`);
  await sharp(pixels, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outputPath);
  return outputPath;
};

await mkdir(assetsDir, { recursive: true });
const outputPaths = await Promise.all(
  palettes.map((palette, pageIndex) => renderPage(pageIndex, palette)),
);

console.log(JSON.stringify({
  outputPaths,
  width,
  height,
  pageCount: outputPaths.length,
  center: base,
  cornerStrength: "0.155-0.179",
  opaque: true,
}, null, 2));

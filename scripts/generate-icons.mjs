// public/icon.svg を正として、PWA / iOS / ブラウザー用のアイコンを再生成する。
//   npm run icons
// sharp は Next.js の画像処理用依存を利用する。
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const requireNext = createRequire(require.resolve("next/package.json"));
const sharp = requireNext("sharp");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(resolve(root, "public/icon.svg"));
const outputs = [
  { path: "public/icon-192.png", size: 192 },
  { path: "public/icon-512.png", size: 512 },
  { path: "public/icon-maskable-512.png", size: 512 },
  { path: "public/apple-touch-icon.png", size: 180 },
  { path: "public/favicon-32.png", size: 32 },
  { path: "src/app/icon.png", size: 64 },
];

for (const output of outputs) {
  const png = await sharp(source)
    .resize(output.size, output.size)
    .flatten({ background: "#ed8754" })
    .png()
    .toBuffer();
  const target = resolve(root, output.path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, png);
  console.log(`generated ${output.path} (${output.size}x${output.size})`);
}

// PNG を内包する ICO。複数サイズを持たせて小さなタブでも輪郭を保つ。
const faviconSizes = [16, 32, 48];
const faviconImages = await Promise.all(
  faviconSizes.map((size) =>
    sharp(source).resize(size, size).flatten({ background: "#ed8754" }).png().toBuffer(),
  ),
);
const header = Buffer.alloc(6 + 16 * faviconImages.length);
header.writeUInt16LE(1, 2); // ICO
header.writeUInt16LE(faviconImages.length, 4);
let offset = header.length;
for (let index = 0; index < faviconImages.length; index++) {
  const entry = 6 + 16 * index;
  const png = faviconImages[index];
  header[entry] = faviconSizes[index];
  header[entry + 1] = faviconSizes[index];
  header.writeUInt16LE(1, entry + 4); // planes
  header.writeUInt16LE(32, entry + 6); // bits per pixel
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
}
await writeFile(resolve(root, "public/favicon.ico"), Buffer.concat([header, ...faviconImages]));
console.log("generated public/favicon.ico (16x16, 32x32, 48x48)");

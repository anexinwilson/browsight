import sharp from "sharp";
import { mkdirSync } from "fs";

const src =
  "C:/Users/aen/.gemini/antigravity/brain/dde2e649-fe82-47f1-ad67-a223a1bec294/browsight_icon_128_1782833013636.png";
const iconDir = "extension/src/icons";
mkdirSync(iconDir, { recursive: true });
mkdirSync("docs", { recursive: true });

for (const size of [16, 48, 128]) {
  await sharp(src)
    .resize(size, size)
    .png()
    .toFile(`${iconDir}/icon-${size}.png`);
  console.log(`icon-${size}.png written`);
}

await sharp(src).resize(512, 512).png().toFile("docs/logo.png");
console.log("docs/logo.png written");

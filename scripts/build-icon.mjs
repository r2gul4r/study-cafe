// Reproducible multi-resolution Windows icon from the app's vector source.
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const image = await loadImage(
  readFileSync(new URL("../apps/web/public/study-cafe.svg", import.meta.url)),
);
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => {
  const canvas = createCanvas(size, size);
  canvas.getContext("2d").drawImage(image, 0, 0, size, size);
  return canvas.toBuffer("image/png");
});
const header = Buffer.alloc(6 + images.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((png, index) => {
  const entry = 6 + index * 16;
  header[entry] = sizes[index] % 256;
  header[entry + 1] = sizes[index] % 256;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});
mkdirSync(new URL("../assets/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../assets/study-cafe.ico", import.meta.url),
  Buffer.concat([header, ...images]),
);
writeFileSync(
  new URL("../assets/study-cafe.png", import.meta.url),
  images.at(-1),
);
console.log("Created study-cafe.ico (16–256px) and PNG preview");

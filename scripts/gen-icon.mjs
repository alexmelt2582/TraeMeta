/**
 * One-shot icon generator: turns assets/icon-source.jpg into a multi-size
 * assets/icon.ico with the white background knocked out to transparency.
 *
 * Kept as a plain script (not a build dependency) so regenerating the icon
 * does not require any native image library. The ICO encoding is self-contained.
 */
import fs from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";

const PROJECT_ROOT = path.resolve(path.dirname(process.argv[1]), "..");
const SOURCE = path.join(PROJECT_ROOT, "assets", "icon-source.jpg");
const OUTPUT = path.join(PROJECT_ROOT, "assets", "icon.ico");

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICO_HEADER_BYTES = 6;
const ICO_DIRECTORY_BYTES = 16;
const BITMAPINFOHEADER_BYTES = 40;

function isNearWhite(r, g, b, threshold = 240) {
  return r >= threshold && g >= threshold && b >= threshold;
}

/** Box-filter downscale from source RGBA to target size. */
function scaleImage(src, srcW, srcH, dstW, dstH) {
  const dst = Buffer.alloc(dstW * dstH * 4);
  const ratioX = srcW / dstW;
  const ratioY = srcH / dstH;
  for (let dy = 0; dy < dstH; dy += 1) {
    for (let dx = 0; dx < dstW; dx += 1) {
      const sx0 = Math.floor(dx * ratioX);
      const sy0 = Math.floor(dy * ratioY);
      const sx1 = Math.min(srcW, Math.floor((dx + 1) * ratioX));
      const sy1 = Math.min(srcH, Math.floor((dy + 1) * ratioY));
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          const off = (sy * srcW + sx) * 4;
          r += src[off];
          g += src[off + 1];
          b += src[off + 2];
          a += src[off + 3];
          count += 1;
        }
      }
      const off = (dy * dstW + dx) * 4;
      dst[off] = Math.round(r / count);
      dst[off + 1] = Math.round(g / count);
      dst[off + 2] = Math.round(b / count);
      dst[off + 3] = Math.round(a / count);
    }
  }
  return dst;
}

/** DIB stores rows bottom-up; AND mask rows padded to 4-byte boundaries. */
function encodeIcoImage(rgba, size) {
  const xor = Buffer.alloc(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const srcOff = ((size - 1 - row) * size + col) * 4;
      const off = (row * size + col) * 4;
      xor[off] = rgba[srcOff + 2];     // B
      xor[off + 1] = rgba[srcOff + 1]; // G
      xor[off + 2] = rgba[srcOff];     // R
      xor[off + 3] = rgba[srcOff + 3]; // A
    }
  }

  const rowBytes = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(rowBytes * size);

  const header = Buffer.alloc(BITMAPINFOHEADER_BYTES);
  header.writeUInt32LE(BITMAPINFOHEADER_BYTES, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4, 20);

  return Buffer.concat([header, xor, and]);
}

const jpegData = fs.readFileSync(SOURCE);
const decoded = jpeg.decode(jpegData, { useTArray: true });
const { width, height, data } = decoded;

// Knock out the white background to transparency.
for (let i = 0; i < data.length; i += 4) {
  if (isNearWhite(data[i], data[i + 1], data[i + 2])) {
    data[i + 3] = 0;
  }
}

const images = SIZES.map((size) => {
  const rgba = scaleImage(data, width, height, size, size);
  return { size, image: encodeIcoImage(rgba, size) };
});

const header = Buffer.alloc(ICO_HEADER_BYTES + ICO_DIRECTORY_BYTES * images.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);

let offset = ICO_HEADER_BYTES + ICO_DIRECTORY_BYTES * images.length;
images.forEach((img, index) => {
  const dir = ICO_HEADER_BYTES + index * ICO_DIRECTORY_BYTES;
  header.writeUInt8(img.size >= 256 ? 0 : img.size, dir);
  header.writeUInt8(img.size >= 256 ? 0 : img.size, dir + 1);
  header.writeUInt8(0, dir + 2);
  header.writeUInt8(0, dir + 3);
  header.writeUInt16LE(1, dir + 4);
  header.writeUInt16LE(32, dir + 6);
  header.writeUInt32LE(img.image.length, dir + 8);
  header.writeUInt32LE(offset, dir + 12);
  offset += img.image.length;
});

const ico = Buffer.concat([header, ...images.map((i) => i.image)]);
fs.writeFileSync(OUTPUT, ico);
console.log(`wrote ${path.relative(PROJECT_ROOT, OUTPUT)} (${ico.length} bytes, ${images.length} sizes: ${SIZES.join(",")})`);

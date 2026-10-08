#!/usr/bin/env node
/**
 * Generates the admin app icons with no dependencies: a rounded square in the
 * brand green with a white "B". Writes:
 *   public/icons/icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png (180)
 *   public/icons/icon.svg and src/app/icon.svg
 * Usage: node scripts/make-icons.mjs [#brandhex]
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brandHex = (process.argv[2] || "#5bbf3a").replace("#", "");
const BRAND = [0, 2, 4].map((i) => parseInt(brandHex.slice(i, i + 2), 16));
const WHITE = [255, 255, 255];

// ---------- the "B", in unit coordinates (0..1, y down) ----------
const T = 0.11; // stroke
const X0 = 0.31; // left edge of the stem
const TOP = { y0: 0.22, y1: 0.545, xm: 0.5 }; // upper bowl
const BOT = { y0: 0.435, y1: 0.78, xm: 0.52 }; // lower bowl

/** A "D" shape: rectangle from x0 to xm, then a half disc on the right. */
function inD(x, y, x0, y0, y1, xm) {
  if (y < y0 || y > y1 || x < x0) return false;
  if (x <= xm) return true;
  const r = (y1 - y0) / 2;
  const cy = y0 + r;
  return (x - xm) ** 2 + (y - cy) ** 2 <= r * r;
}

function inGlyph(x, y) {
  const outer = inD(x, y, X0, TOP.y0, TOP.y1, TOP.xm) || inD(x, y, X0, BOT.y0, BOT.y1, BOT.xm);
  if (!outer) return false;
  const counterTop = inD(x, y, X0 + T, TOP.y0 + T, TOP.y1 - T, TOP.xm);
  const counterBot = inD(x, y, X0 + T, BOT.y0 + T, BOT.y1 - T, BOT.xm);
  return !(counterTop || counterBot);
}

/** Rounded square of corner radius `r` (unit coordinates). */
function inRoundedSquare(x, y, r) {
  if (x < 0 || y < 0 || x > 1 || y > 1) return false;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// ---------- raster with 4x4 supersampling ----------
function render(size, { radius }) {
  const px = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let bg = 0;
      let fg = 0;
      for (let sj = 0; sj < S; sj++) {
        for (let si = 0; si < S; si++) {
          const x = (i + (si + 0.5) / S) / size;
          const y = (j + (sj + 0.5) / S) / size;
          if (radius === 0 || inRoundedSquare(x, y, radius)) {
            bg++;
            if (inGlyph(x, y)) fg++;
          }
        }
      }
      const n = S * S;
      const alpha = bg / n;
      const f = bg ? fg / bg : 0;
      const o = (j * size + i) * 4;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(BRAND[c] * (1 - f) + WHITE[c] * f);
      px[o + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

// ---------- minimal PNG encoder ----------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- SVG (same geometry) ----------
function svg() {
  const u = (v) => +(v * 512).toFixed(2);
  const d = (x0, y0, y1, xm, ccw) => {
    const r = u((y1 - y0) / 2);
    if (!ccw) return `M${u(x0)} ${u(y0)}H${u(xm)}A${r} ${r} 0 0 1 ${u(xm)} ${u(y1)}H${u(x0)}Z`;
    return `M${u(x0)} ${u(y0)}V${u(y1)}H${u(xm)}A${r} ${r} 0 0 0 ${u(xm)} ${u(y0)}Z`;
  };
  const glyph = [
    d(X0, TOP.y0, TOP.y1, TOP.xm, false),
    d(X0, BOT.y0, BOT.y1, BOT.xm, false),
    d(X0 + T, TOP.y0 + T, TOP.y1 - T, TOP.xm, true),
    d(X0 + T, BOT.y0 + T, BOT.y1 - T, BOT.xm, true),
  ].join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="${u(0.22)}" fill="#${brandHex}"/><path fill="#fff" fill-rule="nonzero" d="${glyph}"/></svg>\n`;
}

const outDir = path.join(root, "public", "icons");
fs.mkdirSync(outDir, { recursive: true });
const write = (name, size, opts) => {
  fs.writeFileSync(path.join(outDir, name), encodePng(size, render(size, opts)));
  console.log(`wrote public/icons/${name} (${size}x${size})`);
};
write("icon-192.png", 192, { radius: 0.22 });
write("icon-512.png", 512, { radius: 0.22 });
write("icon-maskable-512.png", 512, { radius: 0 });
write("apple-touch-icon.png", 180, { radius: 0 }); // iOS rounds the corners itself
const svgText = svg();
fs.writeFileSync(path.join(outDir, "icon.svg"), svgText);
fs.writeFileSync(path.join(root, "src", "app", "icon.svg"), svgText);
console.log("wrote public/icons/icon.svg and src/app/icon.svg");

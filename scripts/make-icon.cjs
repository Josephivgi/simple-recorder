"use strict";

// Draw the Simple Recorder app icon and write the two files the app ships:
//
//   assets/icon.png   256x256 for the window and non-Windows builds
//   assets/icon.ico   16/24/32/48/64/128/256 for Windows shortcuts and the
//                     installed executable's resources
//
//   node scripts/make-icon.cjs
//
// The art is drawn here rather than committed as an opaque blob so the icon
// can be re-rendered at any size the moment it needs a tweak, and so nothing
// in the repo depends on a canvas or image library: the pixels are computed
// directly, supersampled for smooth edges, and encoded with zlib. Electron's
// own atom icon is what a bare rename of electron.exe leaves behind, so this
// file is the difference between "some Electron app" and Simple Recorder.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const ASSETS_DIR = path.join(ROOT, "assets");

// The sizes Windows asks for: 16 (lists, taskbar small), 24/32 (toolbar,
// desktop), 48 (medium icons), 64/128 (large), 256 (extra large, Explorer).
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIZE = 256;
// Sizes at or below this go into the .ico as plain bitmaps; larger ones are
// stored PNG-compressed, which every Windows since Vista reads.
const ICO_BITMAP_MAX = 48;

// Palette. Deep slate plate, white record ring, vivid red dot.
const PLATE_TOP = [58, 74, 107];
const PLATE_BOTTOM = [26, 33, 48];
const RING = [246, 248, 252, 0.94];
const DOT_CORE = [232, 69, 60];
const DOT_EDGE = [255, 118, 106];
const PLATE_RADIUS = 0.22;
const RING_RADIUS = 0.29;
const RING_WIDTH = 0.062;
const DOT_RADIUS = 0.175;

function mix(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

// "Over" compositing of a straight-alpha source onto a straight-alpha
// destination, both [r,g,b,a] with 0..255 channels and 0..1 alpha.
function over(dst, src) {
  const sa = src[3];
  if (sa <= 0) return dst;
  const outA = sa + dst[3] * (1 - sa);
  if (outA <= 0) return [0, 0, 0, 0];
  const keep = dst[3] * (1 - sa);
  return [
    (src[0] * sa + dst[0] * keep) / outA,
    (src[1] * sa + dst[1] * keep) / outA,
    (src[2] * sa + dst[2] * keep) / outA,
    outA,
  ];
}

function insideRoundedRect(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// One supersampled sample at subpixel center (x, y) inside a `size` box.
function sample(x, y, size) {
  let px = [0, 0, 0, 0];
  const radius = PLATE_RADIUS * size;
  if (insideRoundedRect(x, y, size, size, radius)) {
    const t = Math.min(1, Math.max(0, y / size));
    const plate = mix(PLATE_TOP, PLATE_BOTTOM, t);
    px = [plate[0], plate[1], plate[2], 1];
  }
  const c = size / 2;
  const d = Math.hypot(x - c, y - c);
  const ringOuter = (RING_RADIUS + RING_WIDTH / 2) * size;
  const ringInner = (RING_RADIUS - RING_WIDTH / 2) * size;
  if (d <= ringOuter && d >= ringInner) {
    // A soft 0.5px edge keeps the ring from looking chewed at 16px.
    const edge = Math.min((ringOuter - d), (d - ringInner));
    const cover = Math.min(1, Math.max(0, edge + 0.5));
    px = over(px, [RING[0], RING[1], RING[2], RING[3] * cover]);
  }
  const dotR = DOT_RADIUS * size;
  if (d <= dotR) {
    const lit = Math.min(1, Math.max(0, 1 - (Math.hypot(x - c * 1.35, y - c * 1.35) / (dotR * 2.2))));
    const dot = mix(DOT_CORE, DOT_EDGE, lit * 0.85);
    const edge = Math.min(dotR - d + 0.5, 1);
    px = over(px, [dot[0], dot[1], dot[2], Math.min(1, Math.max(0, edge))]);
  }
  return px;
}

// Supersample then box-downsample: cheap anti-aliasing without a library.
function renderIcon(size) {
  const ss = size <= 32 ? 8 : 4;
  const big = size * ss;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const px = sample(
            ((x * ss + sx + 0.5) / big) * size,
            ((y * ss + sy + 0.5) / big) * size,
            size,
          );
          // Accumulate premultiplied so a partially covered edge keeps its hue.
          pr += px[0] * px[3];
          pg += px[1] * px[3];
          pb += px[2] * px[3];
          pa += px[3];
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      if (pa <= 0) continue;
      out[i] = Math.round(pr / pa);
      out[i + 1] = Math.round(pg / pa);
      out[i + 2] = Math.round(pb / pa);
      out[i + 3] = Math.round((pa / n) * 255);
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// PNG, one filter-0 (None) scanline per row.
function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// A 32-bit BMP entry: BITMAPINFOHEADER with a doubled height, BGRA rows
// bottom-up, then the 1bpp AND mask (all zero: the alpha channel does the
// work, but the mask has to be there and padded to 4 bytes per row).
function encodeBmp(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const src = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x += 1) {
      const s = src + x * 4;
      const d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

function encodeIco(sizes) {
  const images = sizes.map((size) => {
    const rgba = renderIcon(size);
    return {
      size,
      data: size <= ICO_BITMAP_MAX ? encodeBmp(rgba, size) : encodePng(rgba, size, size),
    };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = 6 + directory.length;
  images.forEach((image, i) => {
    const at = i * 16;
    directory[at] = image.size >= 256 ? 0 : image.size;
    directory[at + 1] = image.size >= 256 ? 0 : image.size;
    directory[at + 2] = 0;
    directory[at + 3] = 0;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(image.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });
  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

function readIcoHeader(buffer) {
  if (!buffer || buffer.length < 6) return null;
  const count = buffer.readUInt16LE(4);
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1 || count <= 0) return null;
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    if (at + 16 > buffer.length) return null;
    sizes.push(buffer[at] === 0 ? 256 : buffer[at]);
  }
  return { count, sizes };
}

function main() {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  const png = encodePng(renderIcon(PNG_SIZE), PNG_SIZE, PNG_SIZE);
  const ico = encodeIco(ICO_SIZES);
  const pngPath = path.join(ASSETS_DIR, "icon.png");
  const icoPath = path.join(ASSETS_DIR, "icon.ico");
  fs.writeFileSync(pngPath, png);
  fs.writeFileSync(icoPath, ico);
  process.stdout.write(
    "Wrote " + path.relative(ROOT, pngPath) + " (" + png.length + " bytes) and " +
      path.relative(ROOT, icoPath) + " (" + ico.length + " bytes, " + ICO_SIZES.join("/") + ")\n",
  );
}

if (require.main === module) main();

module.exports = { ICO_SIZES, PNG_SIZE, renderIcon, encodePng, encodeIco, readIcoHeader };

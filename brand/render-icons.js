'use strict';
/**
 * Renders the Restaurant Tier List brand marks to PNG.
 *
 * One geometry (a steaming noodle bowl on three stepped tier bars, on a
 * 1024-unit grid) is rasterised three ways:
 *
 *   icon.png           1024x1024  yellow ground, black mark
 *   featured-light.png 1600x900   cream ground, yellow disc, black mark
 *   featured-dark.png  1600x900   black ground, yellow mark
 *
 * Uses only Node core (fs, zlib). Shapes are signed-distance fields;
 * per pixel, coverage = clamp(0.5 - sdf, 0, 1), composited in paint
 * order, so edges anti-alias only between the listed flat colours.
 *
 * Run: node brand/render-icons.js
 * Edit the geometry here and rerun; the PNGs are committed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

// ---- palette (Homeroom brand: Black + Yellow pairing, cream ground) ----
const BLACK = [0x00, 0x00, 0x00];
const YELLOW = [0xff, 0xee, 0x6f]; // #FFEE6F
const CREAM = [0xff, 0xfe, 0xea]; // #FFFEEA

// ---- mark geometry (1024 grid), nudged -12 in y to centre vertically ----
const MARK = {
  steam: [
    { x: 390, y: 184, w: 44, h: 104, r: 22 },
    { x: 490, y: 144, w: 44, h: 144, r: 22 },
    { x: 590, y: 184, w: 44, h: 104, r: 22 },
  ],
  rim: { x: 248, y: 324, w: 528, h: 48, r: 24 },
  bowl: { cx: 512, cy: 348, r: 232 },
  band: { x: 320, y: 428, w: 384, h: 40, r: 0 }, // drawn last, in the cut-out colour
  foot: { x: 432, y: 572, w: 160, h: 36, r: 12 },
  bars: [
    { x: 352, y: 640, w: 320, h: 64, r: 32 },
    { x: 272, y: 728, w: 480, h: 64, r: 32 },
    { x: 192, y: 816, w: 640, h: 64, r: 32 },
  ],
};

// ---- signed distance fields ----

function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const dx = Math.abs(px - cx) - (w / 2 - r);
  const dy = Math.abs(py - cy) - (h / 2 - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

// Lower half-disc: the bowl.
function sdBowl(px, py, cx, cy, r) {
  return Math.max(Math.hypot(px - cx, py - cy) - r, cy - py);
}

// A paint layer: an sdf in final pixel units, a colour, and a culling box.
function layer(sdfGrid, bboxGrid, scale, tx, ty, colour) {
  return {
    colour,
    x0: tx + scale * bboxGrid[0] - 1,
    y0: ty + scale * bboxGrid[1] - 1,
    x1: tx + scale * bboxGrid[2] + 1,
    y1: ty + scale * bboxGrid[3] + 1,
    sdf(px, py) {
      return sdfGrid((px - tx) / scale, (py - ty) / scale) * scale;
    },
  };
}

function rectLayer(shape, scale, tx, ty, colour) {
  const { x, y, w, h, r } = shape;
  return layer(
    (px, py) => sdRoundRect(px, py, x, y, w, h, r),
    [x, y, x + w, y + h],
    scale, tx, ty,
    colour
  );
}

function bowlLayer(shape, scale, tx, ty, colour) {
  const { cx, cy, r } = shape;
  return layer(
    (px, py) => sdBowl(px, py, cx, cy, r),
    [cx - r, cy, cx + r, cy + r],
    scale, tx, ty,
    colour
  );
}

function discLayer(cx, cy, r, colour) {
  return {
    colour,
    x0: cx - r - 1,
    y0: cy - r - 1,
    x1: cx + r + 1,
    y1: cy + r + 1,
    sdf: (px, py) => Math.hypot(px - cx, py - cy) - r,
  };
}

// The mark's paint layers in order; the band (cut-out colour) goes last.
function markLayers(scale, tx, ty, markColour, bandColour) {
  const layers = [];
  for (const s of MARK.steam) layers.push(rectLayer(s, scale, tx, ty, markColour));
  layers.push(rectLayer(MARK.rim, scale, tx, ty, markColour));
  layers.push(bowlLayer(MARK.bowl, scale, tx, ty, markColour));
  layers.push(rectLayer(MARK.foot, scale, tx, ty, markColour));
  for (const s of MARK.bars) layers.push(rectLayer(s, scale, tx, ty, markColour));
  layers.push(rectLayer(MARK.band, scale, tx, ty, bandColour));
  return layers;
}

// ---- rasteriser ----

function render(width, height, ground, layers) {
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const sy = y + 0.5;
    for (let x = 0; x < width; x++) {
      const sx = x + 0.5;
      let r = ground[0];
      let g = ground[1];
      let b = ground[2];
      for (const l of layers) {
        if (sx < l.x0 || sx > l.x1 || sy < l.y0 || sy > l.y1) continue;
        const cov = Math.min(1, Math.max(0, 0.5 - l.sdf(sx, sy)));
        if (cov === 0) continue;
        const [cr, cg, cb] = l.colour;
        if (cov === 1) {
          r = cr; g = cg; b = cb;
        } else {
          r += (cr - r) * cov;
          g += (cg - g) * cov;
          b += (cb - b) * cov;
        }
      }
      const i = (y * width + x) * 3;
      out[i] = Math.round(r);
      out[i + 1] = Math.round(g);
      out[i + 2] = Math.round(b);
    }
  }
  return out;
}

// ---- PNG encoding (8-bit RGB, colour type 2, filter 0) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgb.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- small-size previews (written to the OS temp dir, not the repo) ----

function downsample(src, srcW, srcH, dstSize) {
  const out = Buffer.alloc(dstSize * dstSize * 3);
  const f = srcW / dstSize;
  for (let dy = 0; dy < dstSize; dy++) {
    const y0 = Math.floor(dy * f);
    const y1 = Math.max(y0 + 1, Math.floor((dy + 1) * f));
    for (let dx = 0; dx < dstSize; dx++) {
      const x0 = Math.floor(dx * f);
      const x1 = Math.max(x0 + 1, Math.floor((dx + 1) * f));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * srcW + x) * 3;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
        }
      }
      const o = (dy * dstSize + dx) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return out;
}

// Composite a square image onto a backdrop through a rounded-corner mask,
// as the platform rounds the tile.
function compositeRounded(img, size, backdrop, radius) {
  const out = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = sdRoundRect(x + 0.5, y + 0.5, 0, 0, size, size, radius);
      const cov = Math.min(1, Math.max(0, 0.5 - d));
      const i = (y * size + x) * 3;
      for (let c = 0; c < 3; c++) {
        out[i + c] = Math.round(img[i + c] * cov + backdrop[c] * (1 - cov));
      }
    }
  }
  return out;
}

// ---- build ----

const OUT_DIR = __dirname;
const SCALE = 0.75;
const FTx = 416;
const FTy = 66; // centres the 1024 grid in 1600x900

const targets = [
  {
    file: 'icon.png',
    width: 1024,
    height: 1024,
    ground: YELLOW,
    layers: markLayers(1, 0, 0, BLACK, YELLOW),
  },
  {
    file: 'featured-light.png',
    width: 1600,
    height: 900,
    ground: CREAM,
    layers: [
      discLayer(800, 450, 400, YELLOW),
      ...markLayers(SCALE, FTx, FTy, BLACK, YELLOW),
    ],
  },
  {
    file: 'featured-dark.png',
    width: 1600,
    height: 900,
    ground: BLACK,
    layers: markLayers(SCALE, FTx, FTy, YELLOW, BLACK),
  },
];

let failed = false;
for (const t of targets) {
  const rgb = render(t.width, t.height, t.ground, t.layers);
  const png = encodePNG(t.width, t.height, rgb);
  const file = path.join(OUT_DIR, t.file);
  fs.writeFileSync(file, png);

  // Read the header back: signature, dimensions, size limit.
  const back = fs.readFileSync(file);
  const sigOk = back.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const w = back.readUInt32BE(16);
  const h = back.readUInt32BE(20);
  const kb = (back.length / 1024).toFixed(1);
  const ok = sigOk && w === t.width && h === t.height;
  console.log(`${t.file}: ${w}x${h}, ${kb} KB${ok ? '' : '  MISMATCH'}`);
  if (!ok) failed = true;
  if (t.file === 'icon.png' && back.length > 256 * 1024) {
    console.error(`icon.png is over the 256 KB icon limit`);
    failed = true;
  }
  t.rgb = rgb;
}

// Previews: the icon at 64 and 32 px on white and black, rounded as tiles are.
const previewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-previews-'));
for (const size of [64, 32]) {
  const small = downsample(targets[0].rgb, 1024, 1024, size);
  for (const [name, backdrop] of [['white', [255, 255, 255]], ['black', [0, 0, 0]]]) {
    const masked = compositeRounded(small, size, backdrop, Math.round(size * 0.22));
    fs.writeFileSync(path.join(previewDir, `icon-${size}-${name}.png`), encodePNG(size, size, masked));
  }
}
console.log(`previews: ${path.join(previewDir)}`);

process.exit(failed ? 1 : 0);

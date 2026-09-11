/*
 * installer-assets.cjs — produce the installer's two bitmaps and its icon.
 *
 * RUN BY HAND, NEVER BY THE BUILD. `node scripts/installer-assets.cjs` regenerates
 *   gui-pro/src-tauri/assets/installer/header-150x57.bmp
 *   gui-pro/src-tauri/assets/installer/sidebar-164x314.bmp
 *   gui-pro/src-tauri/assets/installer/installer.ico
 * and the results are COMMITTED as binary assets. Nothing in the application, in vite, in cargo or
 * in CI calls this file.
 *
 * WHY IT IS A SEPARATE SCRIPT AND NOT AN IMPORT.
 *   The artwork these bitmaps reproduce lives at `gui-pro/src/components/_story/installer/
 *   installerArtwork.tsx`, and that whole `_story/` tier is EXCLUDED from the release branch by
 *   directory (CLAUDE.md § «Что НЕ идёт на release»). A build-time import of an excluded file type-
 *   checks locally and breaks `tsc` + `vite build` on the release branch — i.e. it passes on the
 *   machine that writes it and fails on the branch that ships. So the geometry is RE-STATED here in
 *   plain SVG rather than imported, and the two copies are kept honest by the one thing that can be
 *   checked: the numbers below carry the same provenance comments as their originals.
 *
 * WHY THE COLOURS ARE HEX LITERALS HERE AND NOWHERE ELSE.
 *   The installer understands no CSS custom properties — it takes numbers. The design contract says
 *   so explicitly and names this the single place the six-digit values may be written
 *   (memory/v3/screens/app-installer.md § «Палитра — одна светлая, всегда»). Every value below is
 *   copied from `gui-pro/src/shared/styles/tokens.css` with the token name beside it.
 *
 * WHY THERE IS NO IMAGE LIBRARY.
 *   Adding `sharp` / `resvg` to `package.json` would put a native dependency on the release branch
 *   for an asset produced once. Instead: headless Chrome rasterises the SVG (it is already the
 *   project's own preview tool), and the PNG→BMP step is ~120 lines of `zlib` below. The output
 *   format is not a preference — MUI2 wants an UNCOMPRESSED BMP with NO alpha channel, and a wrong
 *   format either fails the build or renders black with no diagnostic.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SRC_TAURI = path.join(ROOT, "gui-pro", "src-tauri");
const OUT_DIR = path.join(SRC_TAURI, "assets", "installer");
const SHIELD_SVG = path.join(ROOT, "gui-pro", "public", "logo", "shield-dark.svg");
const APP_ICON = path.join(SRC_TAURI, "icons", "icon.ico");

// ─── the palette, from tokens.css ──────────────────────────────────────────────
// THE GROUND IS ONE CONSTANT, NOT TWO SIMILAR VALUES. The header strip runs the full width of the
// window; the installer paints the part left of the bitmap with the page background itself. If the
// wash inside the bitmap has not returned to EXACTLY this colour by its own left edge, a vertical
// seam appears across the window. Same constant makes the sidebar's square corners fall on an
// invisible ground so the eye reads a rounded card. `--color-bg-primary`.
const GROUND = "#f9f9f7";
const ACCENT = {
  50: "#f0f4f4",
  100: "#d9e8e7",
  200: "#b3d1cf",
  300: "#80b3b0",
  400: "#4d9490",
  500: "#2d7a76",
  600: "#236260",
  700: "#1a4a48",
  800: "#123533",
  900: "#0b2221",
};

// ─── geometry, mirroring installerArtwork.tsx ─────────────────────────────────
const SIDEBAR = { width: 164, height: 314 };
const HEADER = { width: 150, height: 57 };
/** 10 px on all four sides — the number that turns a panel welded to the window edge into a card. */
const PANEL_INSET = 10;
/** `--radius-xl` = 16. The largest shape takes the largest radius; nothing here is square. */
const PANEL_RADIUS = 16;
/** The mark's box is square because the source viewBox is `0 0 256 256`. */
const SHIELD_BOX = 72;

/** The product's mark, inlined as-is: six nested shields, no strokes, never redrawn. */
function shieldPaths() {
  const svg = fs.readFileSync(SHIELD_SVG, "utf8");
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "");
  if (!/<path/.test(inner)) {
    throw new Error(`${SHIELD_SVG} yielded no <path> — the mark is the one thing that must not be redrawn`);
  }
  return inner.trim();
}

/** The mark at an arbitrary size, from the one source, so the two bitmaps cannot diverge. */
function shieldAt(x, y, size) {
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 256 256" preserveAspectRatio="xMidYMid meet">${shieldPaths()}</svg>`;
}

function sidebarSvg() {
  const { width, height } = SIDEBAR;
  const px = PANEL_INSET;
  const pw = width - PANEL_INSET * 2;
  const ph = height - PANEL_INSET * 2;
  const cx = width / 2;
  const rings = [
    { r: 46, o: 0.06 },
    { r: 62, o: 0.04 },
    { r: 78, o: 0.03 },
  ];
  // The tunnel motif: three nested arcs opening downward, so the bottom third of a 314 px panel is
  // not empty. Same visual idea as the rings, not a second one.
  const arcs = [
    { r: 40, o: 0.08 },
    { r: 60, o: 0.05 },
    { r: 80, o: 0.03 },
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${ACCENT[800]}"/>
      <stop offset="100%" stop-color="${ACCENT[900]}"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${ACCENT[600]}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="${ACCENT[600]}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${ACCENT[50]}" stop-opacity="0.06"/>
      <stop offset="40%" stop-color="${ACCENT[50]}" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="clip"><rect x="${px}" y="${px}" width="${pw}" height="${ph}" rx="${PANEL_RADIUS}"/></clipPath>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="${GROUND}"/>
  <rect x="${px}" y="${px}" width="${pw}" height="${ph}" rx="${PANEL_RADIUS}" fill="url(#panel)"/>
  <g clip-path="url(#clip)">
    <circle cx="${cx}" cy="96" r="88" fill="url(#glow)"/>
    ${rings
      .map(
        (g) =>
          `<circle cx="${cx}" cy="96" r="${g.r}" fill="none" stroke="${ACCENT[400]}" stroke-width="1" stroke-opacity="${g.o}"/>`
      )
      .join("\n    ")}
    ${arcs
      .map(
        (a) =>
          `<path d="M ${cx - a.r} 300 A ${a.r} ${a.r} 0 0 1 ${cx + a.r} 300" fill="none" stroke="${ACCENT[400]}" stroke-width="2" stroke-opacity="${a.o}"/>`
      )
      .join("\n    ")}
    <rect x="${px}" y="${px}" width="${pw}" height="${ph}" fill="url(#sweep)"/>
  </g>
  <g transform="translate(${cx - SHIELD_BOX / 2} 54)">${shieldAt(0, 0, SHIELD_BOX)}</g>
  <text x="${cx}" y="156" text-anchor="middle" fill="${ACCENT[50]}"
        font-family="Outfit, 'Geist Sans', 'Segoe UI', system-ui, sans-serif"
        font-size="17" font-weight="600" letter-spacing="-0.17">TrustTunnel</text>
  <rect x="${cx - 24}" y="168" width="48" height="18" rx="9" fill="${ACCENT[700]}"/>
  <text x="${cx}" y="181" text-anchor="middle" fill="${ACCENT[200]}"
        font-family="'Geist Sans', 'Segoe UI', system-ui, sans-serif"
        font-size="11" font-weight="500" letter-spacing="0.22">PRO</text>
</svg>`;
}

function headerSvg() {
  const { width, height } = HEADER;
  // The mark stands directly on the strip — no tile. It keeps the box the removed 40 × 40 tile
  // occupied (x = 94, y = 8) so the composition is unchanged, but takes the full strip height:
  // 34 px instead of the 22 that were left inside the tile's padding.
  const glyph = 34;
  const gx = 94 + 40 / 2 - glyph / 2;
  const gy = 8 + 40 / 2 - glyph / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="wash" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${GROUND}"/>
      <stop offset="16%" stop-color="${GROUND}"/>
      <stop offset="55%" stop-color="${ACCENT[200]}"/>
      <stop offset="100%" stop-color="${ACCENT[400]}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="${GROUND}"/>
  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#wash)"/>
  ${shieldAt(gx, gy, glyph)}
</svg>`;
}

// ─── headless Chrome: SVG → PNG at exact pixel size ────────────────────────────
const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.CHROME_PATH,
].filter(Boolean);

function findChrome() {
  const hit = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!hit) throw new Error("no chrome.exe found — set CHROME_PATH");
  return hit;
}

function rasterise(svg, size, tmp, name) {
  const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:${GROUND};width:${size.width}px;height:${size.height}px;overflow:hidden}
svg{display:block}
</style>${svg}`;
  const htmlPath = path.join(tmp, `${name}.html`);
  const pngPath = path.join(tmp, `${name}.png`);
  fs.writeFileSync(htmlPath, html, "utf8");
  execFileSync(
    findChrome(),
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--default-background-color=FFF9F9F7",
      `--window-size=${size.width},${size.height}`,
      "--virtual-time-budget=4000",
      `--screenshot=${pngPath}`,
      `--user-data-dir=${path.join(tmp, `profile-${name}`)}`,
      `file:///${htmlPath.replace(/\\/g, "/")}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  if (!fs.existsSync(pngPath)) throw new Error(`chrome produced no screenshot for ${name}`);
  return fs.readFileSync(pngPath);
}

// ─── PNG → raw RGBA ────────────────────────────────────────────────────────────
// Only the shapes Chrome emits: 8-bit, non-interlaced, colour type 2 (RGB) or 6 (RGBA). Anything
// else throws rather than guessing — a silently mis-decoded bitmap is exactly the failure class
// this whole asset pipeline is careful about.
function decodePng(buf) {
  const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colour: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error("PNG has no IHDR");
  if (ihdr.depth !== 8 || ihdr.interlace !== 0 || (ihdr.colour !== 2 && ihdr.colour !== 6)) {
    throw new Error(`unsupported PNG: depth=${ihdr.depth} colour=${ihdr.colour} interlace=${ihdr.interlace}`);
  }
  const channels = ihdr.colour === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * channels;
  const out = Buffer.alloc(ihdr.height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: throw new Error(`unknown PNG filter ${filter}`);
      }
      cur[x] = v;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width: ihdr.width, height: ihdr.height, channels, pixels: out };
}

// ─── raw RGBA → 24-bit uncompressed BMP ───────────────────────────────────────
// NO ALPHA CHANNEL IN THE FILE. Every rounded edge, shadow and glow is flattened against the ground
// here, before saving; leaving alpha in produces a dark or white fringe on all four corners under a
// toolkit that does not read it. 24-bit is what MUI2 documents; rows are bottom-up and padded to a
// four-byte boundary, which is the part hand-rolled encoders usually get wrong.
function encodeBmp24(img, groundHex) {
  const g = [
    parseInt(groundHex.slice(1, 3), 16),
    parseInt(groundHex.slice(3, 5), 16),
    parseInt(groundHex.slice(5, 7), 16),
  ];
  const rowBytes = img.width * 3;
  const pad = (4 - (rowBytes % 4)) % 4;
  const stride = rowBytes + pad;
  const pixels = Buffer.alloc(stride * img.height);
  for (let y = 0; y < img.height; y++) {
    const dst = (img.height - 1 - y) * stride; // bottom-up
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * img.channels;
      let r = img.pixels[s], gr = img.pixels[s + 1], b = img.pixels[s + 2];
      if (img.channels === 4) {
        const a = img.pixels[s + 3] / 255;
        r = Math.round(r * a + g[0] * (1 - a));
        gr = Math.round(gr * a + g[1] * (1 - a));
        b = Math.round(b * a + g[2] * (1 - a));
      }
      pixels[dst + x * 3] = b;
      pixels[dst + x * 3 + 1] = gr;
      pixels[dst + x * 3 + 2] = r;
    }
  }
  const header = Buffer.alloc(54);
  header.write("BM", 0, "ascii");
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(img.width, 18);
  header.writeInt32LE(img.height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(0, 30); // BI_RGB — uncompressed, which is the requirement
  header.writeUInt32LE(pixels.length, 34);
  header.writeInt32LE(2835, 38);
  header.writeInt32LE(2835, 42);
  return Buffer.concat([header, pixels]);
}

// ─── run ───────────────────────────────────────────────────────────────────────
function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-installer-assets-"));
  try {
    for (const [name, svg, size] of [
      ["header-150x57", headerSvg(), HEADER],
      ["sidebar-164x314", sidebarSvg(), SIDEBAR],
    ]) {
      const png = decodePng(rasterise(svg, size, tmp, name));
      if (png.width !== size.width || png.height !== size.height) {
        throw new Error(`${name}: chrome rendered ${png.width}x${png.height}, wanted ${size.width}x${size.height}`);
      }
      const bmp = encodeBmp24(png, GROUND);
      fs.writeFileSync(path.join(OUT_DIR, `${name}.bmp`), bmp);
      console.log(`wrote ${name}.bmp — ${png.width}x${png.height}, 24-bit, ${bmp.length} bytes`);
    }

    // THE ICON IS THE APPLICATION'S OWN, not a second drawing of it. «Значок установщика берётся у
    // самого приложения — это тот же щит» (design contract § «Значки»). Copying the app's proven
    // .ico rather than re-rasterising the mark means the installer and the application can never
    // show two subtly different shields, and re-running this script re-syncs the copy.
    fs.copyFileSync(APP_ICON, path.join(OUT_DIR, "installer.ico"));
    console.log(`wrote installer.ico — copied from ${path.relative(ROOT, APP_ICON).replace(/\\/g, "/")}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();

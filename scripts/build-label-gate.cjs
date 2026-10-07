/*
 * build-label-gate.cjs — a test build's label must never reach a release.
 *
 * WHY THIS EXISTS
 *   The build-hash environment variable that stamps a test build lives for as long as the
 *   PowerShell window stays open, and every test build sets it. Build a release installer in the
 *   same window without clearing it first, and the label ships silently: the build does not fail,
 *   every other gate stays green, and only an eye on «О программе» would catch it.
 *
 * WHY THE ANCHOR IS THE `buildHash:` PROPERTY LITERAL, NOT THE ENVIRONMENT VARIABLE
 *   Reading the variable that produced the build proves nothing about what the build actually
 *   embedded — the variable can change, or be unset, after the bundle was written. The only fact
 *   that matters is what the compiled call site carries. A minifier renames every function and
 *   local it is free to rename, but it must keep an object literal's PROPERTY KEY intact (renaming
 *   `buildHash` would change what property the reader destructures) — so `buildHash:` followed by a
 *   string literal is the one anchor a minification pass cannot remove without breaking the code it
 *   minifies. A bare 6-character token search would also match unrelated strings; this gate never
 *   does that.
 *
 * WHY THE EXE IS SEARCHED FOR THE ASSET KEY, NOT GREPPED FOR THE LABEL
 *   Tauri Brotli-compresses each asset's BODY before embedding it, so the label text inside a
 *   compressed chunk cannot be found by a byte search of the executable at all. The asset's KEY —
 *   its path, `assets/<chunk file name>` — is stored uncompressed, so searching for the key proves
 *   whether a given dist/ chunk is the one the executable actually embeds. `dist/` can be rebuilt
 *   after the executable without anyone rebuilding the installer; reading a chunk the exe does not
 *   embed would be reading a bundle that does not ship, so that case reports STALE rather than a
 *   verdict about the wrong file.
 *
 * Usage: node scripts/build-label-gate.cjs --dist <dir> --exe <path>
 * Exit:  0 no label, 1 label compiled in, 2 cannot measure / stale.
 */
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * All `buildHash:` property-literal occurrences in `text`.
 * Matches a `"`, `'` or plain backtick string literal following the `buildHash:` key, handling
 * backslash escapes so an escaped quote inside the value does not end the literal early. A
 * backtick literal containing `${` (an actual template interpolation, not a plain string) is
 * skipped — it is not a literal build label. A non-literal value (an identifier, e.g. the
 * destructuring form `{buildHash:t}`) is ignored: this is exactly what happens when the label call
 * site has moved to a form this gate cannot read, and is reported as CANNOT MEASURE by the caller.
 * Returns `{ value, offset }[]`, in the order found (findings across files are sorted by the caller).
 */
function findLabelLiterals(text) {
  const results = [];
  const keyRe = /buildHash\s*:/g;
  let m;
  while ((m = keyRe.exec(text)) !== null) {
    const keyEnd = m.index + m[0].length;
    let i = keyEnd;
    while (i < text.length && /\s/.test(text[i])) i++;
    const quote = text[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      // Not a literal (identifier, function call, etc.) — nothing to read here.
      keyRe.lastIndex = keyEnd;
      continue;
    }
    let j = i + 1;
    let raw = "";
    let sawInterpolation = false;
    let closed = false;
    while (j < text.length) {
      const ch = text[j];
      if (ch === "\\" && j + 1 < text.length) {
        raw += ch + text[j + 1];
        j += 2;
        continue;
      }
      if (quote === "`" && ch === "$" && text[j + 1] === "{") {
        sawInterpolation = true;
        break;
      }
      if (ch === quote) {
        closed = true;
        j++;
        break;
      }
      raw += ch;
      j++;
    }
    if (!closed || sawInterpolation) {
      // An actual template literal with interpolation, or an unterminated string — not a plain
      // compiled-in literal. Resume scanning right after the key so we do not re-match inside it.
      keyRe.lastIndex = keyEnd;
      continue;
    }
    const value = raw.replace(/\\(.)/g, "$1");
    results.push({ value, offset: m.index });
    keyRe.lastIndex = j;
  }
  return results;
}

/**
 * Whether `chunkFileName` is embedded in the executable at `exeBuffer` — i.e. whether its asset
 * key appears in the exe's bytes. Asset keys are stored uncompressed even though Tauri
 * Brotli-compresses each asset's body, so this is a plain byte search, never a decompression.
 */
function isChunkEmbedded(exeBuffer, chunkFileName) {
  return exeBuffer.indexOf(Buffer.from(`assets/${chunkFileName}`, "latin1")) !== -1;
}

/**
 * Reads every `.js` chunk in `distDir`/assets, finds any compiled-in `buildHash:` literal, proves
 * each chunk that carries one is embedded in the executable at `exePath`, and judges the result.
 * Returns `{ code, lines }`. Reads no environment variable at all — its only inputs are the two
 * paths given on the command line.
 */
function judge({ distDir, exePath }) {
  const assetsDir = path.join(distDir, "assets");
  let entries;
  try {
    entries = fs.readdirSync(assetsDir);
  } catch {
    return {
      code: 2,
      lines: [`CANNOT MEASURE: no dist/assets directory in ${distDir} — build the frontend first (npm run build)`],
    };
  }
  const jsFiles = entries.filter((n) => n.endsWith(".js")).sort();
  if (jsFiles.length === 0) {
    return {
      code: 2,
      lines: [`CANNOT MEASURE: no .js files in ${assetsDir} — build the frontend first (npm run build)`],
    };
  }

  // Collect every buildHash: literal across every chunk, sorted by chunk file name then offset
  // (the ordering edge: with labels in several chunks, every one is reported in a stable order).
  const findings = [];
  for (const file of jsFiles) {
    const text = fs.readFileSync(path.join(assetsDir, file), "utf8");
    for (const lit of findLabelLiterals(text)) {
      findings.push({ chunk: file, value: lit.value, offset: lit.offset });
    }
  }
  findings.sort((a, b) => (a.chunk === b.chunk ? a.offset - b.offset : a.chunk < b.chunk ? -1 : 1));

  if (findings.length === 0) {
    return {
      code: 2,
      lines: [`CANNOT MEASURE: no string-literal buildHash in ${assetsDir} — the call site moved or nothing was built`],
    };
  }

  let exeBuffer;
  try {
    exeBuffer = fs.readFileSync(exePath);
  } catch {
    return {
      code: 2,
      lines: [`CANNOT MEASURE: cannot read ${exePath} — build the installer first (npx tauri build --bundles nsis)`],
    };
  }

  const chunksWithFindings = [...new Set(findings.map((f) => f.chunk))].sort();
  const staleChunks = chunksWithFindings.filter((c) => !isChunkEmbedded(exeBuffer, c));
  if (staleChunks.length > 0) {
    const lines = staleChunks.map(
      (chunk) =>
        `STALE: ${chunk} is not the bundle ${path.basename(exePath)} embeds — dist/ was rebuilt after ` +
        "the executable; rebuild the installer (npx tauri build --bundles nsis) and re-run",
    );
    // Labels seen are informational only here — the STALE verdict does not vouch for them either way.
    for (const f of findings) lines.push(`  (seen: buildHash="${f.value}" in ${f.chunk})`);
    return { code: 2, lines };
  }

  const nonEmpty = findings.filter((f) => f.value !== "");
  if (nonEmpty.length > 0) {
    const lines = nonEmpty.map(
      (f) =>
        `RESULT: FAIL — build label "${f.value}" is compiled into ${f.chunk}; unset VITE_BUILD_HASH ` +
        "(Remove-Item Env:VITE_BUILD_HASH) and rebuild",
    );
    return { code: 1, lines };
  }

  const lines = chunksWithFindings.map(
    (chunk) => `RESULT: PASS — no build label in ${chunk} (embedded in ${path.basename(exePath)})`,
  );
  return { code: 0, lines };
}

function main(argv) {
  const args = argv.slice(2);
  const distIdx = args.indexOf("--dist");
  const exeIdx = args.indexOf("--exe");
  const distArg = distIdx !== -1 ? args[distIdx + 1] : undefined;
  const exeArg = exeIdx !== -1 ? args[exeIdx + 1] : undefined;
  if (!distArg || !exeArg) {
    console.error("build-label-gate: usage:");
    console.error("  node scripts/build-label-gate.cjs --dist <dir> --exe <path>");
    return 2;
  }
  const result = judge({ distDir: path.resolve(distArg), exePath: path.resolve(exeArg) });
  for (const line of result.lines) console.log(line);
  return result.code;
}

module.exports = {
  findLabelLiterals,
  isChunkEmbedded,
  judge,
};

if (require.main === module) process.exit(main(process.argv));

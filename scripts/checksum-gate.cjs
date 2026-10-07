/*
 * checksum-gate.cjs — the installer's SHA-256 must never be missing when it ships.
 *
 * WHY THIS EXISTS
 *   The `.sha256` asset of v3.0.0-pro was placed by hand, and live 3.0.0 installs fetch it far
 *   more often than the installer itself (549 vs 61) — the update path polls it on every check.
 *   If the file is forgotten once, every 3.0.0 user's «Обновить» downloads the installer and
 *   reports an integrity error, because updater.rs has nothing to verify the download against.
 *
 * THE CONTRACT (updater.rs is the source of truth; this script conforms to it, not the reverse —
 *   gui-pro/src-tauri/src/commands/updater.rs, resolve_release_sha256 / verify_checksum)
 *   - Asset name: `format!("{installer}.sha256")` — the installer's own file name plus the literal
 *     suffix, never assembled from a version.
 *   - Content: the digest is the FIRST whitespace-separated token (`text.split_whitespace().next()`),
 *     exactly 64 ASCII hex characters (`is_hex_sha256`: `s.len() == 64 && ...is_ascii_hexdigit()`),
 *     compared case-insensitively (`eq_ignore_ascii_case`, verify_checksum).
 *   - Size: the updater refuses to read more than `MAX_DIGEST_BYTES` (4 KiB) of a digest asset.
 *   - Edition: the asset belongs to whichever installer's name it is derived from
 *     (`is_pro_installer_asset_name`: contains "Pro", contains "setup", ends ".exe").
 *
 * WHAT THIS DOES NOT DO
 *   Verify mode (the default, the one `prerelease` runs) NEVER writes or repairs the `.sha256` —
 *   a gate that fixes what it checks can never be red, and the file that must be uploaded to the
 *   release would still be forgotten. Only `--write` creates or replaces it.
 *
 * Usage: node scripts/checksum-gate.cjs [--write] <nsis-bundle-dir>
 * Exit:  0 pass/written, 1 findings, 2 could not measure.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/** The largest `.sha256` body the updater will read (updater.rs `MAX_DIGEST_BYTES = 4 * 1024`). */
const MAX_DIGEST_BYTES = 4 * 1024;

function sha256OfFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** sha256sum-style line: `<digest>  <name>\n`, matching what `resolve_release_sha256` parses. */
function digestLine(hex, name) {
  return `${hex.toLowerCase()}  ${name}\n`;
}

/** The first whitespace-separated token, or "" — mirrors `text.split_whitespace().next()`. */
function firstToken(text) {
  const m = /\S+/.exec(text);
  return m ? m[0] : "";
}

/** Exactly 64 ASCII hex characters — mirrors updater.rs `is_hex_sha256`. */
function isHexSha256(s) {
  return typeof s === "string" && /^[0-9a-fA-F]{64}$/.test(s);
}

/** Same rule as updater.rs `is_pro_installer_asset_name`. */
function isProInstallerName(name) {
  return typeof name === "string" && name.includes("Pro") && name.includes("setup") && name.endsWith(".exe");
}

/**
 * Pro installers in `dir`, sorted by name for deterministic output.
 * Returns null when the directory does not exist (distinct from "exists but empty").
 */
function findInstallers(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  return entries.filter((n) => isProInstallerName(n)).sort();
}

/** CANNOT MEASURE lines shared by verify and write — never a silent pass over nothing. */
function cannotMeasure(dir, installers) {
  if (installers === null) {
    return { code: 2, lines: [`CANNOT MEASURE: no such directory ${dir}`] };
  }
  if (installers.length === 0) {
    return { code: 2, lines: [`CANNOT MEASURE: no Pro installer in ${dir}`] };
  }
  if (installers.length > 1) {
    return {
      code: 2,
      lines: [
        `CANNOT MEASURE: ${installers.length} Pro installers in ${dir} (${installers.join(", ")}) — ` +
          "remove the stale ones; the gate never guesses which file ships",
      ],
    };
  }
  return null;
}

/**
 * Verify the `.sha256` beside the one Pro installer in `dir` against the installer's own bytes.
 * Never writes (P-02-03-1) — this is what `npm run checksum:check` / `prerelease` runs.
 */
function verifyDir(dir) {
  const installers = findInstallers(dir);
  const measure = cannotMeasure(dir, installers);
  if (measure) return measure;

  const installer = installers[0];
  const installerPath = path.join(dir, installer);
  const shaName = `${installer}.sha256`;
  const shaPath = path.join(dir, shaName);

  let stat;
  try {
    stat = fs.statSync(shaPath);
  } catch {
    return { code: 1, lines: [`RESULT: FAIL — ${shaName} is missing — run npm run checksum:write after the build`] };
  }
  if (stat.size > MAX_DIGEST_BYTES) {
    return {
      code: 1,
      lines: [`RESULT: FAIL — ${shaName} is ${stat.size} bytes; the updater reads at most ${MAX_DIGEST_BYTES}`],
    };
  }

  const text = fs.readFileSync(shaPath, "utf8");
  const candidate = firstToken(text);
  if (!isHexSha256(candidate)) {
    return {
      code: 1,
      lines: [`RESULT: FAIL — ${shaName} is not a sha256sum line (first token must be 64 hex characters)`],
    };
  }

  const actual = sha256OfFile(installerPath);
  if (actual.toLowerCase() !== candidate.toLowerCase()) {
    return { code: 1, lines: [`RESULT: FAIL — digest mismatch: file says ${candidate}, installer is ${actual}`] };
  }

  return { code: 0, lines: [`RESULT: PASS — ${shaName} matches ${installer}`] };
}

/**
 * Compute the digest and write `<installer>.sha256` next to it, then verify what was written.
 * Writes a temp file in the same directory and renames it over the target, so an interrupted run
 * leaves either the previous `.sha256` or the new one — never a half-written file. A leftover
 * temp file is not named `<installer>.sha256` and verify ignores it.
 */
function writeDir(dir) {
  const installers = findInstallers(dir);
  const measure = cannotMeasure(dir, installers);
  if (measure) return measure;

  const installer = installers[0];
  const installerPath = path.join(dir, installer);
  const shaName = `${installer}.sha256`;
  const shaPath = path.join(dir, shaName);

  const hex = sha256OfFile(installerPath);
  const line = digestLine(hex, installer);
  const tmpPath = path.join(dir, `${shaName}.tmp-${process.pid}`);
  fs.writeFileSync(tmpPath, line, "utf8");
  fs.renameSync(tmpPath, shaPath);

  return verifyDir(dir);
}

function main(argv) {
  const args = argv.slice(2);
  const writeMode = args.includes("--write");
  const dirArg = args.find((a) => a !== "--write");
  if (!dirArg) {
    console.error("checksum-gate: name the NSIS bundle directory to check, e.g.");
    console.error("  node scripts/checksum-gate.cjs [--write] <nsis-bundle-dir>");
    return 2;
  }
  const dir = path.resolve(dirArg);
  const result = writeMode ? writeDir(dir) : verifyDir(dir);
  for (const line of result.lines) console.log(line);
  return result.code;
}

module.exports = {
  sha256OfFile,
  digestLine,
  firstToken,
  isHexSha256,
  isProInstallerName,
  findInstallers,
  verifyDir,
  writeDir,
  MAX_DIGEST_BYTES,
};

if (require.main === module) process.exit(main(process.argv));

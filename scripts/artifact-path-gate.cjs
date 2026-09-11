/*
 * artifact-path-gate.cjs — a built binary must not carry the name of the account it was built on.
 *
 * WHY THIS EXISTS
 *   `pii-gate.cjs` reads source. Compilers write paths the source never contains: rustc records a
 *   panic location per dependency crate, MSVC widens `__FILE__` into UTF-16 for `assert`, build
 *   scripts hand over 8.3 short forms, and C++ `__FILE__` carries the checkout and package-cache
 *   paths. A build made inside a user profile therefore ships that profile's account name in
 *   hundreds of strings while the source tree is clean.
 *
 *   The cure is not in this file: build from a directory outside the profile (CLAUDE.md, release
 *   build section — `C:\ttb`, `CARGO_HOME`, `CONAN_HOME`). This file is the check that the cure was
 *   applied, because a build that forgot it succeeds, passes every other gate, and looks identical.
 *
 * WHAT IT FLAGS, in ASCII and in UTF-16LE (Windows APIs and MSVC's wide `__FILE__` are UTF-16)
 *   1. `X:\Users\<name>\` for any <name> not in GENERIC_ACCOUNTS — whoever built it.
 *   2. The name of the account running this gate, and the machine's name, anywhere at all — the
 *      build machine's own identity is the value most likely to be baked in, by any mechanism.
 *
 * WHAT IT DOES NOT FLAG
 *   Vendor binaries shipped verbatim, by (basename, name) with a written reason — VENDOR_BUILD_HOSTS.
 *   Their build paths are someone else's and are covered by their signature: we cannot rebuild them
 *   and must not patch them.
 *
 * Usage: node scripts/artifact-path-gate.cjs <file-or-directory>...
 * Exit:  0 clean, 1 findings, 2 could not run (no input, unreadable input).
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/** Account directory names that identify nobody. Compared case-insensitively. */
const GENERIC_ACCOUNTS = new Set([
  "public", "default", "default user", "all users", "defaultapppool",
  "runneradmin",          // GitHub Actions' Windows runner
  "<user>", "%username%", // documentation placeholders
]);

/** (basename, account) pairs that belong to a vendor's build machine, not ours. */
const VENDOR_BUILD_HOSTS = new Map([
  // The WireGuard author's own build profile, measured in the 0.14.1 DLL we ship byte-for-byte
  // under the vendor's signature. Keyed by the FULL directory name: the first draft keyed «jason»
  // from a scanner that stopped at the space, and the gate — correctly — refused the real file.
  ["wintun.dll|jason a. donenfeld", "WireGuard author's build host, in the vendor-signed DLL"],
]);

/** Extensions that are build bookkeeping, never shipped: they name the build dir by design. */
const NOT_SHIPPED_EXTS = new Set([".nsi", ".nsh", ".pdb", ".d", ".log", ".json", ".txt", ".rsp"]);

const USERS_PATH = /[A-Za-z]:[\\/]+Users[\\/]+([^\\/\x00-\x1f"'<>|:*?]{1,64}?)[\\/]/g;

/** The identities of the machine running the gate. Overridable so the tests never need real ones. */
function buildIdentities(env = process.env) {
  const ids = [];
  const account = env.ARTIFACT_GATE_ACCOUNT || safeUsername();
  const machine = env.ARTIFACT_GATE_MACHINE || env.COMPUTERNAME || os.hostname();
  if (account && account.length >= 3 && !GENERIC_ACCOUNTS.has(account.toLowerCase())) {
    ids.push({ kind: "build account", value: account });
  }
  if (machine && machine.length >= 3) ids.push({ kind: "build machine", value: machine });
  return ids;
}

function safeUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return "";
  }
}

/** Findings for one buffer. `name` is the file's basename, for the vendor allowlist. */
function scanBuffer(buf, name, identities) {
  const findings = [];
  const views = [
    ["ascii", buf.toString("latin1")],
    ["utf16", buf.toString("utf16le")],
    // A UTF-16 string at an odd offset is invisible to the even-aligned view above.
    ["utf16", buf.length > 1 ? buf.subarray(1).toString("utf16le") : ""],
  ];
  const seen = new Set();
  for (const [enc, text] of views) {
    for (const m of text.matchAll(USERS_PATH)) {
      const account = m[1].trim();
      const lower = account.toLowerCase();
      if (GENERIC_ACCOUNTS.has(lower)) continue;
      if (VENDOR_BUILD_HOSTS.has(`${name.toLowerCase()}|${lower}`)) continue;
      const key = `path|${lower}|${enc}`;
      if (!seen.has(key)) findings.push({ kind: "account path", value: account, enc, sample: m[0], count: 0 });
      seen.add(key);
      findings.find((f) => f.kind === "account path" && f.value.toLowerCase() === lower && f.enc === enc).count++;
    }
    const lowerText = text.toLowerCase();
    for (const id of identities) {
      const needle = id.value.toLowerCase();
      let at = lowerText.indexOf(needle);
      let count = 0;
      while (at !== -1) {
        count++;
        at = lowerText.indexOf(needle, at + needle.length);
      }
      const key = `${id.kind}|${enc}`;
      if (count && !seen.has(key)) {
        seen.add(key);
        findings.push({ kind: id.kind, value: id.value, enc, sample: "", count });
      }
    }
  }
  return findings;
}

function listFiles(target, acc = []) {
  const st = fs.statSync(target);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(target)) listFiles(path.join(target, e), acc);
  } else if (st.isFile() && !NOT_SHIPPED_EXTS.has(path.extname(target).toLowerCase())) {
    acc.push(target);
  }
  return acc;
}

function main(argv) {
  const targets = argv.slice(2);
  if (!targets.length) {
    console.error("artifact-path-gate: name the built files or directories to check");
    return 2;
  }
  let files;
  try {
    files = targets.flatMap((t) => listFiles(path.resolve(t)));
  } catch (e) {
    console.error(`artifact-path-gate: COULD NOT RUN — ${e.message}`);
    return 2;
  }
  if (!files.length) {
    console.error("artifact-path-gate: COULD NOT RUN — no shippable file under the given paths");
    return 2;
  }
  const identities = buildIdentities();
  let bad = 0;
  for (const f of files) {
    const findings = scanBuffer(fs.readFileSync(f), path.basename(f), identities);
    if (!findings.length) continue;
    bad++;
    console.log(`\n${f}`);
    for (const x of findings) {
      console.log(`  ${x.kind} «${x.value}» ×${x.count} (${x.enc})${x.sample ? `  e.g. ${x.sample}` : ""}`);
    }
  }
  console.log(`\nartifact-path-gate: ${files.length} file(s) checked`);
  if (bad) {
    console.log(`RESULT: FAILURE — ${bad} file(s) carry the build machine's identity.`);
    console.log("Rebuild outside the user profile (CLAUDE.md, release build: C:\\ttb, CARGO_HOME, CONAN_HOME).");
    return 1;
  }
  console.log("RESULT: PASS — no build-machine account or name inside the artifacts.");
  return 0;
}

module.exports = { scanBuffer, buildIdentities, GENERIC_ACCOUNTS, VENDOR_BUILD_HOSTS };

if (require.main === module) process.exit(main(process.argv));

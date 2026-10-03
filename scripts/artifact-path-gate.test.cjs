/*
 * Self-tests for artifact-path-gate.cjs.
 *
 * Every positive arm uses an invented account name (`mvolkov`, the same synthetic name the PII
 * gate's suite uses) and an invented machine name. The gate's own identity check reads the real
 * account and machine name of whoever runs it; the CLI arms override both through
 * ARTIFACT_GATE_ACCOUNT / ARTIFACT_GATE_MACHINE so this file never needs, and never holds, a real one.
 *
 * Run: node scripts/artifact-path-gate.test.cjs   (npm run artifact:test from gui-pro/)
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { scanBuffer } = require("./artifact-path-gate.cjs");
const GATE = path.join(__dirname, "artifact-path-gate.cjs");

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  FAIL ${name}\n       ${e && e.message}`);
  }
}

const NAME = "mvolkov";
const MACHINE = "BOXNAME7";
/** A compile-time path the way rustc and MSVC write it, for an arbitrary account directory. */
const pathFor = (account) => ["C:", "Users", account, ".cargo", "registry", "src", "lib.rs"].join("\\");
/** Bytes of a fake binary: noise, the string, noise — as a linker lays a string table out. */
const blob = (s, enc = "latin1", pad = 0) =>
  Buffer.concat([Buffer.alloc(64 + pad, 0x90), Buffer.from(s, enc), Buffer.alloc(64, 0)]);
const kinds = (f) => f.map((x) => `${x.kind}:${x.value}:${x.enc}`);

test("1. an account path in ASCII is caught — rustc's panic locations", () => {
  const f = scanBuffer(blob(pathFor(NAME)), "app.exe", []);
  assert.deepStrictEqual(kinds(f), [`account path:${NAME}:ascii`]);
});

test("2. the same path in UTF-16 is caught — MSVC's wide __FILE__ inside assert()", () => {
  const f = scanBuffer(blob(pathFor(NAME), "utf16le"), "app.exe", []);
  assert.deepStrictEqual(kinds(f), [`account path:${NAME}:utf16`]);
});

test("3. a UTF-16 string at an ODD offset is caught too — alignment is the linker's choice", () => {
  const f = scanBuffer(blob(pathFor(NAME), "utf16le", 1), "app.exe", []);
  assert.deepStrictEqual(kinds(f), [`account path:${NAME}:utf16`]);
});

test("4. an 8.3 short path is caught — build scripts hand those to the C compiler", () => {
  const short = ["C:", "Users", NAME, "CARGO~1", "registry"].join("\\");
  assert.deepStrictEqual(kinds(scanBuffer(blob(short), "app.exe", [])), [`account path:${NAME}:ascii`]);
});

test("5. generic account directories identify nobody and stay silent", () => {
  for (const g of ["Public", "Default", "runneradmin", "<user>", "All Users"]) {
    assert.deepStrictEqual(scanBuffer(blob(pathFor(g)), "app.exe", []), [], g);
  }
});

test("6. a vendor build host is excused ONLY in that vendor's file, and only by its full name", () => {
  const vendor = pathFor("Jason A. Donenfeld"); // the public WireGuard author, as in wintun.dll
  assert.deepStrictEqual(scanBuffer(blob(vendor), "wintun.dll", []), [], "wintun.dll ships verbatim");
  assert.deepStrictEqual(kinds(scanBuffer(blob(vendor), "app.exe", [])), ["account path:Jason A. Donenfeld:ascii"]);
  // A prefix of the vendor's name is somebody else's directory, not the vendor's.
  assert.deepStrictEqual(kinds(scanBuffer(blob(pathFor("Jason")), "wintun.dll", [])), ["account path:Jason:ascii"]);
});

test("7. the build account's name is caught ANYWHERE, not only inside a Users path", () => {
  const ids = [{ kind: "build account", value: NAME }];
  const f = scanBuffer(blob(`profile=${NAME};`), "app.exe", ids);
  assert.deepStrictEqual(kinds(f), [`build account:${NAME}:ascii`]);
});

test("8. the build machine's name is caught, case-insensitively, in both encodings", () => {
  const ids = [{ kind: "build machine", value: MACHINE }];
  const f = scanBuffer(blob(`host ${MACHINE.toLowerCase()} built this`, "utf16le"), "app.exe", ids);
  assert.deepStrictEqual(kinds(f), [`build machine:${MACHINE}:utf16`]);
});

test("9. A CLEAN BINARY PASSES — and the scan really looked (a planted path in the same bytes fails)", () => {
  const clean = blob("C:\\ttb\\cargo\\registry\\src\\lib.rs /rustc/abc/library/std/src/panicking.rs");
  assert.deepStrictEqual(scanBuffer(clean, "app.exe", [{ kind: "build account", value: NAME }]), []);
  const dirty = Buffer.concat([clean, blob(pathFor(NAME))]);
  assert.strictEqual(scanBuffer(dirty, "app.exe", []).length, 1);
});

// ─── the CLI, end to end ──────────────────────────────────────────────────────
function run(args) {
  const env = { ...process.env, ARTIFACT_GATE_ACCOUNT: NAME, ARTIFACT_GATE_MACHINE: MACHINE };
  return spawnSync(process.execPath, [GATE, ...args], { encoding: "utf8", env });
}
function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-gate-"));
  for (const [rel, buf] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), buf);
  return dir;
}

test("10. CLI: a clean directory exits 0, a dirty one exits 1 and names the file", () => {
  const clean = tree({ "app.exe": blob("nothing to see") });
  const dirty = tree({ "app.exe": blob("nothing"), "core.exe": blob(pathFor(NAME), "utf16le") });
  try {
    assert.strictEqual(run([clean]).status, 0);
    const r = run([dirty]);
    assert.strictEqual(r.status, 1, r.stdout);
    assert.match(r.stdout, /core\.exe/);
    assert.doesNotMatch(r.stdout, /app\.exe\n/, "the clean file must not be reported");
  } finally {
    fs.rmSync(clean, { recursive: true, force: true });
    fs.rmSync(dirty, { recursive: true, force: true });
  }
});

test("11. CLI: build bookkeeping (.nsi, .pdb, .json) is not a shipped artifact and is skipped", () => {
  const dir = tree({ "installer.nsi": blob(pathFor(NAME)), "app.exe": blob("clean") });
  try {
    assert.strictEqual(run([dir]).status, 0, "the generated NSIS script names the build dir by design");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("12. CLI: nothing to check is «could not run» (2), never a clean pass (0)", () => {
  assert.strictEqual(run([]).status, 2);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-gate-"));
  try {
    assert.strictEqual(run([empty]).status, 2, "an empty build dir is a missing build, not a clean one");
    assert.strictEqual(run([path.join(empty, "absent.exe")]).status, 2);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

const total = passed + failures.length;
console.log("");
console.log(`  tests     : ${passed}/${total} passed`);
if (failures.length) {
  console.log("RESULT: FAILURE");
  process.exit(1);
}
console.log("RESULT: PASS");
process.exit(0);

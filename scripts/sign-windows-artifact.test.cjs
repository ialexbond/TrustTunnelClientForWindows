/*
 * sign-windows-artifact.test.cjs — the exercisable half of the signing plumbing.
 *
 * WHAT THIS CAN AND CANNOT PROVE
 *   Phase 32 decision D-01: no certificate is bought and nothing is signed. So the script's
 *   *configured-and-really-signing* path has no way to run here — there is no thumbprint in any
 *   store and no guarantee signtool.exe exists on this machine. Every behaviour that DOES NOT
 *   need a certificate is tested end-to-end by spawning the real script and reading its real
 *   exit code; the two that decide what happens to the signer's exit code are tested by handing
 *   `runSign` a stub spawn, which exercises the decision honestly without pretending a
 *   certificate exists.
 *
 *   The one thing that must never happen is a test that cannot fail. This phase has already
 *   caught two of those. So the detector this file guards (`hasEmbeddedSignature`) is checked
 *   against a SYNTHESISED signed image and a synthesised unsigned one, both built here, and
 *   additionally against a real vendor signature (wintun.dll, signed by WireGuard LLC) whenever
 *   that file is present. A detector broken into always-false or always-true turns this file red
 *   instead of quietly reporting all-clear.
 *
 *   NOTHING HERE HAD EVER RUN UNTIL 2026-09-06 (WS4 finding 3). 285 lines of assertions matched no
 *   vitest glob (`src/**` + `.ts`/`.tsx`, run from `gui-pro/`), no npm script and no workflow step.
 *   They were cited as «13/13 passing» from one manual invocation, which is a body of tests that
 *   reports nothing because nothing invokes it -- this phase's own defect class, in a new place.
 *   Fixed by `npm run sign:test`, wired into `prerelease` and into the «Signing plumbing tests»
 *   step of `.github/workflows/frontend.yml`. Two consequences that must not drift:
 *     * THE SUITE MUST RUN ON A CLEAN CHECKOUT. `wintun.dll` and the sidecar are UNTRACKED build
 *       inputs and `target/release` is gitignored, so any arm keyed on them passes on a
 *       developer's machine and fails on every CI runner. Everything is therefore built into a
 *       temporary tree here, and the one arm that genuinely wants a real vendor certificate
 *       reports itself NOT MEASURED -- printed, counted and named on the summary line.
 *     * The file now travels to the release branch, because a CI step calls it (CLAUDE.md's
 *       «if a CI step calls a script, the script ships with it»).
 *
 * Invoked as: node scripts/sign-windows-artifact.test.cjs   (or `npm run sign:test` from gui-pro/)
 * Exit: 0 all measured tests pass, 1 at least one FAIL.
 */
"use strict";

const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(__dirname, "sign-windows-artifact.cjs");

const mod = require("./sign-windows-artifact.cjs");
const { runSign, hasEmbeddedSignature, ENV_THUMBPRINT } = mod;

// ─── harness ───────────────────────────────────────────────────────────────────
// A SKIP IS PRINTED AND COUNTED, NEVER SILENT. This suite runs on a Linux CI runner where the
// two Windows binaries it once used as fixtures do not exist -- they are untracked build inputs
// copied in by hand, not repository content. A test that quietly returned in that case would be
// the defect this file exists to guard, so the only skip here names its reason and appears in the
// summary line, and everything that CAN be measured anywhere is measured from a SYNTHESISED
// fixture instead.
let passed = 0;
const failures = [];
const skipped = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL  ${name}`);
    console.log(`        ${(e && e.message ? e.message : String(e)).split("\n").join("\n        ")}`);
  }
}
function skip(name, why) {
  skipped.push({ name, why });
  console.log(`SKIP  ${name}`);
  console.log(`        ${why}`);
}

// ─── synthesised PE fixtures ───────────────────────────────────────────────────
// A minimal PE32 image with, or without, a WIN_CERTIFICATE of type PKCS#7 signed data in data
// directory 4. This is what makes the suite runnable on any machine: it exercises exactly the
// structure `hasEmbeddedSignature` reads, and it is built rather than committed, so no binary
// enters the repository. It proves the parser reads the structure it claims; it does NOT prove
// the parser copes with a real signature, which is what the wintun.dll arm below is for.
function makePe({ signed }) {
  const b = Buffer.alloc(0x400);
  b.write("MZ", 0, "latin1");
  const peOff = 0x80;
  b.writeUInt32LE(peOff, 0x3c);
  b.write("PE\0\0", peOff, "latin1");
  const opt = peOff + 24;
  b.writeUInt16LE(0x010b, opt); // PE32
  const entry = opt + 96 + 4 * 8; // data directory index 4
  if (signed) {
    const va = 0x200;
    const certLen = 0x40;
    b.writeUInt32LE(va, entry);
    b.writeUInt32LE(certLen, entry + 4);
    b.writeUInt32LE(certLen, va); // dwLength
    b.writeUInt16LE(0x0200, va + 4); // wRevision
    b.writeUInt16LE(0x0002, va + 6); // WIN_CERT_TYPE_PKCS_SIGNED_DATA
  }
  return b;
}
const PE_SIGNED = makePe({ signed: true });
const PE_UNSIGNED = makePe({ signed: false });

const os = require("os");

/**
 * A tree shaped like a finished bundle. `packedSigned` decides whether the file the emitted
 * installer really packs is signed; `decoySigned` decides the same for the conventional path the
 * old judge read. Making them differ is what separates the two.
 */
function makeBundleFixture({ packedSigned, decoySigned, wireUninstallerSign = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ttsign-fixture-"));
  const app = path.join(dir, "src-tauri");
  const rel = path.join(app, "target", "release");
  fs.mkdirSync(path.join(rel, "nsis", "x64"), { recursive: true });
  fs.mkdirSync(path.join(rel, "bundle", "nsis"), { recursive: true });

  fs.writeFileSync(path.join(app, "tauri.conf.json"), JSON.stringify({ bundle: { externalBin: ["side"] } }));
  fs.writeFileSync(path.join(app, "Cargo.toml"), '[package]\nname = "app"\n');
  fs.writeFileSync(path.join(app, "wintun.dll"), PE_SIGNED); // the gate's rule 0 positive fixture
  fs.writeFileSync(path.join(rel, "app.exe"), PE_SIGNED);
  fs.writeFileSync(path.join(rel, "bundle", "nsis", "App_1.0.0_x64-setup.exe"), PE_SIGNED);

  const packedFile = path.join(app, "side-x86_64-pc-windows-msvc.exe");
  const decoyFile = path.join(rel, "side.exe");
  fs.writeFileSync(packedFile, packedSigned ? PE_SIGNED : PE_UNSIGNED);
  fs.writeFileSync(decoyFile, decoySigned ? PE_SIGNED : PE_UNSIGNED);

  fs.writeFileSync(
    path.join(rel, "nsis", "x64", "installer.nsi"),
    [
      `!define MAINBINARYSRCPATH "${path.join(rel, "app.exe")}"`,
      wireUninstallerSign ? '!define UNINSTALLERSIGNCOMMAND "node sign.cjs %1"' : "; no wiring",
      `    File /a "/oname=side.exe" "${packedFile}"`,
      "",
    ].join("\n")
  );
  return { dir, app, packedFile, decoyFile };
}

// Run the REAL script in a child process. `thumbprint` of undefined means "the variable is not
// in the environment at all"; a string means it is present with that exact value.
function runScript(args, thumbprint) {
  const env = { ...process.env };
  delete env[ENV_THUMBPRINT];
  if (thumbprint !== undefined) env[ENV_THUMBPRINT] = thumbprint;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const ARTIFACT = "/tmp/nonexistent-artifact.exe";
const SECRET = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

// ─── 1..3 — the branch that must never break a build ───────────────────────────

test("1. no certificate variable at all: exit 0 and exactly one stated skip line", () => {
  const r = runScript([ARTIFACT], undefined);
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
  const lines = r.stderr.split(/\r?\n/).filter((l) => l.trim() !== "");
  assert.strictEqual(lines.length, 1, `expected exactly one line on stderr, got ${lines.length}: ${r.stderr}`);
  assert.ok(lines[0].includes(ARTIFACT), `the skip line must name the artifact it skipped: ${lines[0]}`);
  assert.ok(
    /no certificate/i.test(lines[0]),
    `the skip line must say WHY it skipped, not merely that it did: ${lines[0]}`
  );
});

test("2. certificate variable present but empty: byte-identical to it being absent", () => {
  const absent = runScript([ARTIFACT], undefined);
  const empty = runScript([ARTIFACT], "");
  assert.strictEqual(empty.status, absent.status, "exit code differs between empty and absent");
  assert.strictEqual(empty.stdout, absent.stdout, "stdout differs between empty and absent");
  assert.strictEqual(empty.stderr, absent.stderr, "stderr differs between empty and absent");
  assert.strictEqual(empty.status, 0, "an empty identity is not a configured signer — it must not fail the build");
});

test("3. certificate variable present but whitespace only: byte-identical to it being absent", () => {
  const absent = runScript([ARTIFACT], undefined);
  const blank = runScript([ARTIFACT], "   \t  ");
  assert.strictEqual(blank.status, absent.status, "exit code differs between whitespace-only and absent");
  assert.strictEqual(blank.stdout, absent.stdout, "stdout differs between whitespace-only and absent");
  assert.strictEqual(blank.stderr, absent.stderr, "stderr differs between whitespace-only and absent");
});

// ─── 4 — could-not-run is distinct from success and from a rule failure ────────

test("4. invoked with no artifact path: exit 2, the could-not-run code", () => {
  const r = runScript([], undefined);
  assert.strictEqual(r.status, 2, `expected exit 2, got ${r.status}. stderr: ${r.stderr}`);
});

// ─── 5..7 — a configured signer that fails is loud ────────────────────────────

test("5. configured signer that cannot even be launched: non-zero exit", () => {
  // The artifact must EXIST here, or the script short-circuits on the missing file and this
  // test would never reach the branch it is named after.
  const env = { ...process.env };
  env[ENV_THUMBPRINT] = SECRET;
  env.TT_SIGNTOOL = path.join(ROOT, "no", "such", "signtool-does-not-exist.exe");
  const r = spawnSync(process.execPath, [SCRIPT, SCRIPT], { env, encoding: "utf8" });
  assert.notStrictEqual(r.status, 0, "a configured signer that never ran must NOT report success");
  assert.ok(
    /could not be launched/i.test(r.stderr),
    `expected the launch failure to be named, got: ${r.stderr}`
  );
});

test("6. configured signer exiting non-zero: that exact code is propagated", () => {
  const calls = [];
  const code = runSign({
    artifact: "C:/build/app.exe",
    env: { [ENV_THUMBPRINT]: SECRET },
    spawn: (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 5, error: undefined };
    },
    log: () => {},
    exists: () => true,
  });
  assert.strictEqual(code, 5, "the signer's own exit code must reach the bundler unchanged");
  assert.strictEqual(calls.length, 1, "the signer must be invoked exactly once");
  assert.ok(
    calls[0].args.includes("/fd") && calls[0].args.includes("sha256"),
    `expected a SHA-256 file digest in the signer arguments: ${JSON.stringify(calls[0].args)}`
  );
  assert.ok(
    calls[0].args.includes("/td") && calls[0].args.includes("/tr"),
    `expected an RFC-3161 timestamp with a SHA-256 digest: ${JSON.stringify(calls[0].args)}`
  );
});

test("7. configured signer exiting zero: the script exits zero", () => {
  const code = runSign({
    artifact: "C:/build/app.exe",
    env: { [ENV_THUMBPRINT]: SECRET },
    spawn: () => ({ status: 0, error: undefined }),
    log: () => {},
    exists: () => true,
  });
  assert.strictEqual(code, 0, "a successful sign must not fail the build");
});

// ─── 8 — D-29: the log channel never carries the identity ─────────────────────

test("8. no branch ever writes the certificate identity to the log channel", () => {
  const logged = [];
  const log = (m) => logged.push(String(m));

  runSign({ artifact: "C:/build/app.exe", env: {}, spawn: () => ({ status: 0 }), log, exists: () => true });
  runSign({ artifact: "C:/build/app.exe", env: { [ENV_THUMBPRINT]: "" }, spawn: () => ({ status: 0 }), log, exists: () => true });
  runSign({
    artifact: "C:/build/app.exe",
    env: { [ENV_THUMBPRINT]: SECRET },
    spawn: () => ({ status: 0 }),
    log,
    exists: () => true,
  });
  runSign({
    artifact: "C:/build/app.exe",
    env: { [ENV_THUMBPRINT]: SECRET },
    spawn: () => ({ status: 9 }),
    log,
    exists: () => true,
  });

  assert.ok(logged.length > 0, "the script must say something on every branch — silence is the failure mode");
  for (const line of logged) {
    assert.ok(!line.includes(SECRET), `the identity leaked into the log channel: ${line}`);
  }

  // And end-to-end, through the real process, with the identity actually present in the
  // environment: the configured branch runs, the signer is missing, the script is loud — and
  // the identity still never reaches stdout or stderr.
  const env = { ...process.env };
  env[ENV_THUMBPRINT] = SECRET;
  env.TT_SIGNTOOL = path.join(ROOT, "no", "such", "signtool-does-not-exist.exe");
  const r = spawnSync(process.execPath, [SCRIPT, SCRIPT], { env, encoding: "utf8" });
  assert.ok(
    !r.stderr.includes(SECRET) && !r.stdout.includes(SECRET),
    `the identity leaked from the real script: ${r.stdout}${r.stderr}`
  );
});

// ─── 9 — the detector is alive (fixtures, not faith) ──────────────────────────

test("9. the signature detector flags a signed image and spares an unsigned one (synthesised)", () => {
  // Built here, so this arm is measured on every machine including a Linux CI runner. It is the
  // control that keeps the detector from going inert: a detector stuck on always-false fails the
  // first assertion, one stuck on always-true fails the second.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ttsign-pe-"));
  try {
    const yes = path.join(dir, "signed.exe");
    const no = path.join(dir, "unsigned.exe");
    fs.writeFileSync(yes, PE_SIGNED);
    fs.writeFileSync(no, PE_UNSIGNED);
    assert.strictEqual(
      hasEmbeddedSignature(yes).signed,
      true,
      "a PE carrying a PKCS#7 WIN_CERTIFICATE must read as signed; a detector that misses it is inert"
    );
    assert.strictEqual(
      hasEmbeddedSignature(no).signed,
      false,
      "a PE with an empty security data directory must read as unsigned; otherwise the detector would green-light an unsigned release"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 9b — the same question against a REAL vendor signature. wintun.dll is signed by WireGuard LLC
// and the sidecar is genuinely unsigned, so this arm proves the parser copes with a real
// certificate blob and not only with the shape test 9 builds. Both files are UNTRACKED build
// inputs, copied into a working tree by hand, so they are absent on a CI runner by construction.
// The skip is PRINTED AND COUNTED rather than returned silently: a reader of the run must be able
// to see that the real-signature half was not exercised.
{
  const name = "9b. the detector copes with a real vendor signature (wintun.dll)";
  const signedFixture = path.join(ROOT, "gui-pro", "src-tauri", "wintun.dll");
  const unsignedFixture = path.join(
    ROOT,
    "gui-pro",
    "src-tauri",
    "trusttunnel_client-x86_64-pc-windows-msvc.exe"
  );
  if (!fs.existsSync(signedFixture) || !fs.existsSync(unsignedFixture)) {
    skip(
      name,
      "NOT MEASURED: wintun.dll and/or the sidecar are absent. They are untracked build inputs, " +
        "so this arm cannot run on a clean checkout. Test 9 above covers the same detector against " +
        "a synthesised image; what is unproven here is only the REAL certificate blob."
    );
  } else {
    test(name, () => {
      assert.strictEqual(
        hasEmbeddedSignature(signedFixture).signed,
        true,
        "wintun.dll carries a real WireGuard LLC signature; a detector that misses it is inert"
      );
      assert.strictEqual(
        hasEmbeddedSignature(unsignedFixture).signed,
        false,
        "the sidecar is unsigned; a detector that claims otherwise would green-light an unsigned release"
      );
    });
  }
}

// ─── 10..11 — the post-build assertion ────────────────────────────────────────

test("10. post-build with no certificate: the signed arm is reported unmeasurable, never passed", () => {
  // Against a SYNTHESISED bundle tree, not against gui-pro: `target/release` is gitignored, so a
  // test keyed on the real one passes on a developer's machine and fails on every clean checkout
  // for a reason that has nothing to do with signing.
  const fx = makeBundleFixture({ packedSigned: false, decoySigned: false });
  try {
    const r = runScript(["--post-build", fx.app], undefined);
    const out = r.stdout + r.stderr;
    assert.strictEqual(r.status, 0, `expected exit 0 with no certificate configured, got ${r.status}: ${out}`);
    assert.ok(/UNMEASURABLE/.test(out), `the signed arm must announce that it cannot be measured: ${out}`);
    assert.ok(
      !/PASS\s+signed/i.test(out) && !/signed[^\n]*\bPASS\b/i.test(out),
      `the signed arm must not print a pass while it cannot run: ${out}`
    );
    assert.ok(/unsigned by configuration/i.test(out), `the absence of a certificate must be a printed statement: ${out}`);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("11. post-build when the expected artifacts are absent: a failure, never a skip", () => {
  const r = runScript(["--post-build", "gui-light"], undefined);
  assert.notStrictEqual(
    r.status,
    0,
    "--post-build was asked for and the artifacts are not there; reporting success would be the vacuum this gate exists to avoid"
  );
});

// ─── 12..13 — what a real bundle run taught, kept from regressing ─────────────

test("12. everything the script prints is pure ASCII", () => {
  // A real bundle run showed an em dash arriving as «тАФ» in the NSIS console: that console
  // decodes our UTF-8 bytes as the machine's single-byte codepage, silently. Same class of bug
  // nsis-text-gate.cjs guards at the byte level; same cheap answer.
  // The fixture run is in the list because it is the ONLY one that reaches the full post-build
  // report -- the UNMEASURABLE paragraphs, the artifact-class listing and the packed-vs-convention
  // NOTE. On a clean checkout the gui-pro run stops at rule 1, so those lines would never be
  // swept and an em dash could be reintroduced into them unnoticed.
  const fx = makeBundleFixture({ packedSigned: true, decoySigned: false });
  const runs = [
    runScript([ARTIFACT], undefined),
    runScript([ARTIFACT], ""),
    runScript(["--post-build", "gui-pro"], undefined),
    runScript(["--post-build", "gui-light"], undefined),
    runScript(["--post-build", fx.app], SECRET),
    runScript([], undefined),
  ];
  fs.rmSync(fx.dir, { recursive: true, force: true });
  for (const r of runs) {
    for (const [stream, text] of [["stdout", r.stdout], ["stderr", r.stderr]]) {
      const bad = [...text].find((ch) => ch.charCodeAt(0) > 127);
      assert.ok(
        bad === undefined,
        `non-ASCII U+${bad ? bad.charCodeAt(0).toString(16) : ""} on ${stream}: a Windows console ` +
          `will render it as mojibake. Offending text: ${text.slice(0, 200)}`
      );
    }
  }
});

test("13. the skip statement reaches both streams when a parent is capturing them", () => {
  // The Tauri bundler captures the sign command and echoes only stdout ("Output of signing
  // command:"); NSIS's !uninstfinalize inherits stderr. A statement on one stream alone is
  // invisible from one of the two callers, and an invisible statement is the same as silence —
  // which is exactly the failure mode the unconfigured branch exists to avoid.
  const r = runScript([ARTIFACT], undefined);
  assert.ok(/unsigned by configuration/i.test(r.stderr), `nothing stated on stderr: ${r.stderr}`);
  assert.ok(/unsigned by configuration/i.test(r.stdout), `nothing stated on stdout: ${r.stdout}`);
});

// ─── 14..16 — the judge measures what ships, and says UNMEASURABLE otherwise ──
//
// These three exist because the judge was VACUOUS in two places until 2026-09-06 (WS4 finding 2),
// and both were demonstrated: with a certificate configured the gate printed «RESULT: PASS», «3/3
// measurable rule(s) passed» and «the rule was asserted against the bytes of each one» over (A) an
// uninstaller class decided by a config-emitted define and (B) a resources class read from
// `target/release/<name>.exe` while the installer packs `src-tauri/<name>-<triple>.exe`.
//
// They run against the synthesised bundle tree built at the top of this file, for the same reason
// test 10 does: a real `target/release/nsis/x64/installer.nsi` only exists after a bundle.

test("14. the resources class is judged from the file the installer packs, not the conventional one", () => {
  // The shipping file is UNSIGNED and the conventional path holds a SIGNED decoy. A judge reading
  // convention calls this build signed; a judge reading what ships calls it what it is.
  const fx = makeBundleFixture({ packedSigned: false, decoySigned: true });
  try {
    const r = runScript(["--post-build", fx.app], SECRET);
    const out = r.stdout + r.stderr;
    assert.notStrictEqual(
      r.status,
      0,
      `the file that SHIPS carries no signature, so this must fail. Got exit 0:\n${out}`
    );
    assert.ok(
      out.includes("side-x86_64-pc-windows-msvc.exe"),
      `the verdict must name the file the installer packs: ${out}`
    );
    assert.ok(
      /convention would have read/.test(out),
      `a disagreement between the packed path and the conventional one must be printed, not silent: ${out}`
    );
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("15. the uninstaller is never reported as signed on the strength of a define", () => {
  // Everything that exists as bytes IS signed here, and the define IS present -- the exact state
  // in which the old judge printed a clean PASS over four classes while only three were measured.
  const fx = makeBundleFixture({ packedSigned: true, decoySigned: false });
  try {
    const r = runScript(["--post-build", fx.app], SECRET);
    const out = r.stdout + r.stderr;
    assert.strictEqual(r.status, 0, `every measurable class is signed, so this must not fail:\n${out}`);
    assert.ok(
      /UNMEASURABLE[\s\S]*uninstaller/i.test(out),
      `the uninstaller class must be reported UNMEASURABLE: ${out}`
    );
    assert.ok(
      !/the uninstaller:[^\n]*carries a signature/.test(out),
      `the gate must never claim the uninstaller carries a signature -- it cannot see one: ${out}`
    );
    assert.ok(
      !/asserted against the bytes of each one/.test(out),
      `the summary must not claim every class was asserted from bytes when one of them cannot be: ${out}`
    );
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("16. a missing UNINSTALLERSIGNCOMMAND is a failure, not a shrug", () => {
  // The control for 15: the define proves nothing when present, but its ABSENCE is a real defect
  // the gate can prove -- without it no certificate on earth reaches the uninstaller. If this
  // passed, rule 3 would be a rubber stamp and 15 would be asserting over nothing.
  const fx = makeBundleFixture({ packedSigned: true, decoySigned: true, wireUninstallerSign: false });
  try {
    const r = runScript(["--post-build", fx.app], SECRET);
    const out = r.stdout + r.stderr;
    assert.notStrictEqual(r.status, 0, `an unwired uninstaller sign command must fail:\n${out}`);
    assert.ok(
      /no UNINSTALLERSIGNCOMMAND/.test(out),
      `the failure must name the missing wiring: ${out}`
    );
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

// ─── report ────────────────────────────────────────────────────────────────────
// The skip count is on the summary line, not buried in the scrollback, and each skipped arm is
// named again underneath. A suite that reports «16/16 passed» while an arm was never measured is
// telling the reader something untrue by omission, which is the whole subject of this file.
const total = passed + failures.length;
console.log("");
console.log(
  `  tests     : ${passed}/${total} passed` +
    (skipped.length ? `, ${skipped.length} NOT MEASURED on this machine` : "")
);
for (const s of skipped) console.log(`  not measured: ${s.name}`);
if (failures.length) {
  console.log("RESULT: FAILURE");
  process.exit(1);
}
console.log(skipped.length ? "RESULT: the measured arms hold; see NOT MEASURED above." : "RESULT: PASS");
process.exit(0);

/*
 * sign-windows-artifact.cjs -- Authenticode signing, wired but certificate-less (D-02).
 *
 * WHY THIS EXISTS
 *   Phase 32 decision D-01: no certificate is bought here and nothing is signed. Decision D-02:
 *   everything EXCEPT the certificate is built now, so that the day one exists a signed release
 *   is a same-day job and not a new phase. The bundler calls this file once per artifact through
 *   `bundle.windows.signCommand`, and it has exactly two jobs:
 *
 *     no certificate configured -> say so out loud and EXIT 0, breaking nothing;
 *     certificate configured    -> sign, and propagate the signer's exit code unchanged.
 *
 *   The upstream `scripts/win_sign_binary.py` could not be reused: it exits 2 when its signer
 *   service is unconfigured (win_sign_binary.py:13-21), and a non-zero exit from signCommand
 *   fails the whole bundle -- so wiring it in unchanged would break every build on a machine with
 *   no certificate, the exact inverse of D-02. Its one-argument SHAPE is reused; its unconfigured
 *   BEHAVIOUR is inverted. That file is left untouched: it is upstream cargo, nothing in this
 *   repository calls it, and deleting it would widen scope for no benefit.
 *
 * NO BRANCH HERE IS ALLOWED TO PASS VACUOUSLY
 *   A silent skip cannot be told apart from a successful sign by reading a build log -- that is
 *   what the skip is FOR. So two things follow, and both are load-bearing:
 *
 *     1. The absence of a certificate is a PRINTED STATEMENT, never a silence. A build that says
 *        nothing about signing is the failure mode; a build that says the artifact is unsigned by
 *        configuration is not.
 *     2. The distinguishing evidence comes from the ARTIFACT, not the build. --post-build reads
 *        the bytes of what the bundler emitted. And while no certificate exists, that rule cannot
 *        be exercised at all, so it reports UNMEASURABLE. It must never print a pass it did not
 *        earn: this phase has already caught two gates that ticked green over nothing.
 *
 *   The signature detector itself is checked against built fixtures on every --post-build run,
 *   so a detector broken into inertness turns the gate red instead of reporting all-clear.
 *
 *   THE JUDGE ITSELF WAS VACUOUS UNTIL 2026-09-06, IN TWO PLACES (WS4 finding 2), and both were
 *   demonstrated rather than argued. With a certificate configured the gate printed «RESULT: PASS»,
 *   «3/3 measurable rule(s) passed» and the sentence «the rule was asserted against the bytes of
 *   each one» -- while:
 *     (A) the UNINSTALLER class was decided solely by the presence of an UNINSTALLERSIGNCOMMAND
 *         define, which the bundler emits unconditionally from `bundle.windows.signCommand`. That
 *         define is present in a build where nothing at all was signed. A config-emitted define is
 *         a PRECONDITION and never evidence, so the wiring is now its own rule and the class is
 *         reported UNMEASURABLE for ever -- there is no build in which a post-build reader can see
 *         an uninstaller that NSIS generates and signs inside the installer.
 *     (B) the RESOURCES class was read at `target/release/<name>.exe`, derived from convention,
 *         while the installer demonstrably packs `src-tauri/<name>-<target-triple>.exe`. Both
 *         files exist, so the gate could report a signature on bytes that do not ship. Every class
 *         is now judged from the path the EMITTED installer script names, and a disagreement with
 *         the conventional path is printed rather than left silent.
 *   The rule the two share: never let a configuration stand in for evidence, and where no evidence
 *   can exist, say UNMEASURABLE.
 *
 * EVERYTHING THIS SCRIPT PRINTS IS PURE ASCII, AND IT PRINTS TO BOTH STREAMS
 *   Two things were learned from a real bundle run rather than from a build log, which is the
 *   only way either could have been found:
 *
 *   1. An em dash in the skip line came out as mojibake ("тАФ") when NSIS ran this script through
 *      !uninstfinalize: that console decodes our UTF-8 bytes as the machine's single-byte
 *      codepage. This is the same class of silent corruption nsis-text-gate.cjs exists to guard,
 *      and the cheap answer is the same one: emit ASCII only. The test suite asserts it.
 *   2. The Tauri bundler CAPTURES the sign command's output and echoes only what came back on
 *      stdout ("Output of signing command:"), while NSIS's own !uninstfinalize inherits stderr.
 *      So a line written to just one stream is invisible from one of the two callers. The skip
 *      statement is the whole point of the unconfigured branch, so it goes to stderr always, and
 *      additionally to stdout whenever stdout is NOT a terminal - i.e. whenever a parent process
 *      is capturing it. A human running this by hand still sees the line exactly once.
 *
 * SECRETS
 *   The certificate identity is read from the environment and never committed. No branch writes
 *   its value to the log channel -- the skip line names the ARTIFACT, never the variable's
 *   contents (project invariant D-29). A thumbprint is not itself sensitive, but this same branch
 *   will later read a key identifier, and the rule is cheaper to establish now than to retrofit.
 *
 * CONFIGURATION (environment only -- nothing here goes in a committed file)
 *   TT_SIGN_THUMBPRINT     SHA-1 thumbprint of the signing certificate in the machine's store.
 *                          Unset, empty or whitespace-only all mean "no certificate": an empty
 *                          identity is not a configured signer, and silently trying to sign with
 *                          one is how a build produces an artifact nobody can account for.
 *   TT_SIGN_TIMESTAMP_URL  RFC-3161 timestamp server. Default: http://timestamp.digicert.com
 *   TT_SIGNTOOL            Path to signtool.exe. Default: `signtool` from PATH.
 *
 * Invoked as: node scripts/sign-windows-artifact.cjs <artifact-path>
 *             node scripts/sign-windows-artifact.cjs --post-build[=<app>] [<app>]
 *   default      -- one artifact, called by the bundler. Never walks the output directory: the
 *                  bundler already signs each artifact at the right moment, and the uninstaller
 *                  inherits the command through NSIS's own UNINSTALLERSIGNCOMMAND define.
 *   --post-build -- asserts what the bundler actually EMITTED, from the bytes. Hard-fails when the
 *                  artifacts are absent, so it can never be a silent no-op.
 * Exit: 0  signed, or a stated skip because no certificate is configured.
 *       N  the configured signer's own non-zero exit code, propagated unchanged.
 *       1  signing was required and did not happen (signer missing, artifact missing), or a
 *          --post-build rule failed.
 *       2  the script itself could not run: no artifact path, or an unusable --post-build target.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ENV_THUMBPRINT = "TT_SIGN_THUMBPRINT";
const ENV_TIMESTAMP = "TT_SIGN_TIMESTAMP_URL";
const ENV_SIGNTOOL = "TT_SIGNTOOL";
const DEFAULT_TIMESTAMP_URL = "http://timestamp.digicert.com";
const ROOT = path.join(__dirname, "..");

/**
 * The configured identity, or null. Unset, empty and whitespace-only are ONE case on purpose:
 * a half-configured environment must not be mistaken for a configured signer.
 */
function configuredThumbprint(env) {
  const raw = env[ENV_THUMBPRINT];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

// ─── the signature detector -- bytes, never console output ──────────────────────
// Windows console output is CP866/UTF-8 depending on the host and is localized, so parsing
// `signtool verify` text would be a second bug waiting to happen. The truth is in the PE:
// data directory 4 (IMAGE_DIRECTORY_ENTRY_SECURITY) points at a WIN_CERTIFICATE whose
// wCertificateType is 0x0002 (WIN_CERT_TYPE_PKCS_SIGNED_DATA) for an Authenticode signature.
//
// This reports PRESENCE and structural well-formedness, not cryptographic trust: verifying a
// chain needs WinVerifyTrust, which Node cannot reach without a native addon. Saying so is the
// point -- the platform checks trust at install time; this checks that a signature is there at
// all, which is exactly the thing a silent skip would leave missing.
function hasEmbeddedSignature(file) {
  let b;
  try {
    b = fs.readFileSync(file);
  } catch (e) {
    return { signed: false, reason: `cannot be read (${e.code || "unknown error"})` };
  }
  if (b.length < 0x40) return { signed: false, reason: "too small to be a PE image" };
  if (b[0] !== 0x4d || b[1] !== 0x5a) return { signed: false, reason: "no MZ header -- not a PE image" };
  const peOff = b.readUInt32LE(0x3c);
  if (peOff + 24 > b.length || b.toString("latin1", peOff, peOff + 4) !== "PE\0\0") {
    return { signed: false, reason: "no PE signature -- not a PE image" };
  }
  const opt = peOff + 24;
  if (opt + 2 > b.length) return { signed: false, reason: "truncated optional header" };
  const magic = b.readUInt16LE(opt);
  const dirs = magic === 0x20b ? opt + 112 : opt + 96; // PE32+ vs PE32
  const entry = dirs + 4 * 8; // data directory index 4
  if (entry + 8 > b.length) return { signed: false, reason: "no security data directory" };
  const va = b.readUInt32LE(entry);
  const size = b.readUInt32LE(entry + 4);
  if (size === 0 || va === 0) return { signed: false, reason: "the security data directory is empty" };
  if (va + 8 > b.length) return { signed: false, reason: "the security data directory points past the file" };
  const certLen = b.readUInt32LE(va);
  const certType = b.readUInt16LE(va + 6);
  if (certType !== 0x0002) {
    return { signed: false, reason: `certificate type 0x${certType.toString(16)} is not PKCS#7 signed data` };
  }
  if (certLen < 8 || va + certLen > b.length) {
    return { signed: false, reason: "the certificate blob runs past the end of the file" };
  }
  return { signed: true, reason: `${certLen} byte PKCS#7 blob at offset ${va}` };
}

// ─── sign mode ─────────────────────────────────────────────────────────────────
/**
 * @returns {number} the process exit code this invocation should produce.
 */
function emit(m) {
  // stderr always: that is the stream NSIS's !uninstfinalize inherits, and the stream this
  // script's contract names. stdout as well whenever it is NOT a terminal, because the Tauri
  // bundler captures the sign command and echoes only stdout -- a line written to stderr alone
  // is invisible from that caller. A human in a terminal still sees it exactly once.
  process.stderr.write(`${m}\n`);
  if (!process.stdout.isTTY) process.stdout.write(`${m}\n`);
}

function runSign({ artifact, env, spawn = spawnSync, log = emit, exists = fs.existsSync }) {
  const thumbprint = configuredThumbprint(env);

  if (thumbprint === null) {
    // The unconfigured branch. It must never fail a build, and it must never be silent.
    // It names the artifact and the reason; it never names the variable's contents.
    log(`sign: no certificate configured -- ${artifact} is UNSIGNED by configuration, skipping.`);
    return 0;
  }

  if (!exists(artifact)) {
    log(`sign: a certificate IS configured but ${artifact} does not exist -- refusing to report success.`);
    return 1;
  }

  const tool = env[ENV_SIGNTOOL] || "signtool";
  const timestampUrl = (env[ENV_TIMESTAMP] || "").trim() || DEFAULT_TIMESTAMP_URL;
  const args = [
    "sign",
    "/fd",
    "sha256",
    "/tr",
    timestampUrl,
    "/td",
    "sha256",
    "/sha1",
    thumbprint,
    artifact,
  ];

  log(`sign: signing ${artifact} with the configured certificate.`);
  const r = spawn(tool, args, { stdio: "inherit" });

  if (r && r.error) {
    log(`sign: the configured signer could not be launched (${r.error.code || r.error.message}) -- signing was required and did not happen.`);
    return 1;
  }
  if (!r || typeof r.status !== "number") {
    log(`sign: the configured signer produced no exit status -- signing was required and did not happen.`);
    return 1;
  }
  if (r.status !== 0) {
    log(`sign: the configured signer failed on ${artifact} (exit ${r.status}).`);
    return r.status;
  }
  log(`sign: ${artifact} signed.`);
  return 0;
}

// ─── post-build mode ───────────────────────────────────────────────────────────
// The four artifact classes the bundler produces, enumerated EXPLICITLY and derived from the
// configuration rather than from convention. Enumerating them by name is the point: a class the
// bundler stops signing after a version bump turns this red instead of being quietly dropped.
const CLASS_MAIN = "the main executable";
const CLASS_RESOURCES = "the bundled resources (external binaries)";
const CLASS_UNINSTALLER = "the uninstaller";
const CLASS_INSTALLER = "the outer installer";

function resolveApp(root, given) {
  const candidates = given
    ? [path.join(root, given), path.join(root, given, "src-tauri"), given, path.join(given, "src-tauri")]
    : [path.join(root, "gui-pro", "src-tauri")];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "tauri.conf.json"))) return c;
  }
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function cargoBinaryName(appDir) {
  try {
    const toml = fs.readFileSync(path.join(appDir, "Cargo.toml"), "utf8");
    const pkg = toml.split(/^\s*\[/m).find((s) => s.startsWith("package]"));
    const m = pkg && pkg.match(/^\s*name\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * What the EMITTED installer script actually packs, read out of the script itself.
 *
 * WHY THIS EXISTS (WS4 finding 2, defect B). The gate used to derive each class's path from
 * CONVENTION -- `target/release/<basename>.exe` for an externalBin. Measured against a real build,
 * that is the wrong file: the installer packs
 * `src-tauri/trusttunnel_client-x86_64-pc-windows-msvc.exe` (the target-triple copy Tauri resolves
 * beside tauri.conf.json), while `target/release/trusttunnel_client.exe` also exists and is what
 * the gate was reading. So the gate could have reported a signature on a file that does not ship,
 * or no signature on one that does -- in both directions, about the wrong bytes.
 *
 * `installer.nsi` is regenerated by the bundler on every build and is EVIDENCE, never a source
 * (the project forbids editing it). It is also the only statement of what ships that cannot drift
 * from the build: `!define MAINBINARYSRCPATH` and each `File /a "/oname=X" "SRC"` name the exact
 * bytes copied in. Reading the fact beats re-deriving the convention -- re-deriving a convention
 * instead of reading the fact is the same error CR-01 found in hygiene rule 19.
 *
 * @returns {{main: string|null, byName: Map<string,string>}|null} null when no script is emitted.
 */
function packedByTheInstaller(nsiFile) {
  let txt;
  try {
    txt = fs.readFileSync(nsiFile, "utf8");
  } catch {
    return null;
  }
  const main = txt.match(/^\s*!define\s+MAINBINARYSRCPATH\s+"([^"]+)"\s*$/m);
  const byName = new Map();
  const re = /^\s*File\s+\/a\s+"\/oname=([^"]+)"\s+"([^"]+)"\s*$/gm;
  let m;
  while ((m = re.exec(txt)) !== null) byName.set(m[1].toLowerCase(), m[2]);
  return { main: main ? main[1] : null, byName };
}

/** Every artifact class, with the concrete path(s) the build actually packed. */
function enumerateArtifacts(appDir) {
  const conf = readJson(path.join(appDir, "tauri.conf.json")) || {};
  const rel = path.join(appDir, "target", "release");
  const nsi = path.join(rel, "nsis", "x64", "installer.nsi");
  const packed = packedByTheInstaller(nsi);
  const out = [];

  // The convention-derived paths are still computed -- not to judge by, but to REPORT when they
  // disagree with what shipped. A silent disagreement is how defect B stayed invisible.
  const mainName = conf.mainBinaryName || cargoBinaryName(appDir);
  out.push({
    klass: CLASS_MAIN,
    kind: "pe",
    file: packed && packed.main ? packed.main : null,
    guessed: mainName ? path.join(rel, `${mainName}.exe`) : null,
    why:
      packed && packed.main
        ? "MAINBINARYSRCPATH in the emitted installer script -- the bytes the installer really packs"
        : "no emitted installer script, so what ships cannot be known: run `npx tauri build --bundles nsis` first",
  });

  for (const bin of (conf.bundle && conf.bundle.externalBin) || []) {
    const oname = `${path.basename(bin)}.exe`;
    const src = packed ? packed.byName.get(oname.toLowerCase()) : undefined;
    out.push({
      klass: CLASS_RESOURCES,
      kind: "pe",
      file: src || null,
      guessed: path.join(rel, oname),
      why: src
        ? `File /oname=${oname} in the emitted installer script`
        : `bundle.externalBin '${bin}' is packed by no line of the emitted installer script (or none has been emitted)`,
    });
  }

  // THE UNINSTALLER IS NOT BYTES ON DISK, AND MUST NEVER BE JUDGED AS IF IT WERE (WS4 finding 2,
  // defect A). NSIS generates it and signs it INSIDE the installer through !uninstfinalize, so no
  // uninstaller file exists after a build. The gate used to accept the presence of the
  // UNINSTALLERSIGNCOMMAND define as evidence for this class -- but the bundler emits that define
  // unconditionally from `bundle.windows.signCommand`, so it is present right now, in a build
  // where nothing at all was signed. A config-emitted define is a PRECONDITION, never evidence:
  // it is asserted on its own (rule 3) and the class itself is reported UNMEASURABLE.
  out.push({
    klass: CLASS_UNINSTALLER,
    kind: "generated-inside-the-installer",
    file: nsi,
    why: "NSIS generates and signs the uninstaller inside the installer through !uninstfinalize; nothing lands on disk to read",
  });

  const nsisDir = path.join(rel, "bundle", "nsis");
  let setup = null;
  try {
    setup = (fs.readdirSync(nsisDir).find((f) => /-setup\.exe$/i.test(f)) || null);
  } catch {
    setup = null;
  }
  out.push({
    klass: CLASS_INSTALLER,
    kind: "pe",
    file: setup ? path.join(nsisDir, setup) : path.join(nsisDir, "<productName>_<version>_x64-setup.exe"),
    why: "the NSIS bundle the user actually downloads",
    missing: !setup,
  });

  return out;
}

function runPostBuild({ root, given, env, log }) {
  const appDir = resolveApp(root, given);
  if (!appDir) {
    log(`sign-windows-artifact: no tauri.conf.json for '${given || "gui-pro"}' -- the gate has no subject and refuses to report success.`);
    return 2;
  }
  const relTo = (p) => path.relative(root, p).split(path.sep).join("/");
  const thumbprint = configuredThumbprint(env);
  const results = [];
  let failures = 0;

  const rule = (id, title, problems, note) => {
    const bad = problems.filter(Boolean);
    if (bad.length) failures++;
    results.push({ id, title, bad, note });
  };

  log(`== sign-windows-artifact (post-build: ${relTo(appDir)}) ==`);

  // ─── RULE 0 -- the detector is alive. Fixtures, not faith. ────────────────────
  // Built, not typed: a genuinely vendor-signed file committed to this repository, and the SAME
  // bytes with the security data directory zeroed. If this rule ever fails, every verdict this
  // gate has printed is worthless, so it runs first and on every invocation.
  {
    const problems = [];
    const positive = path.join(appDir, "wintun.dll");
    if (!fs.existsSync(positive)) {
      problems.push(`${relTo(positive)} is missing -- it is the gate's only genuinely signed fixture, so the detector cannot be checked and this is a failure, not a skip.`);
    } else {
      const yes = hasEmbeddedSignature(positive);
      if (!yes.signed) {
        problems.push(`the detector missed the real vendor signature on ${relTo(positive)} (${yes.reason}) -- it is inert.`);
      }
      const bytes = fs.readFileSync(positive);
      const peOff = bytes.readUInt32LE(0x3c);
      const opt = peOff + 24;
      const dirs = bytes.readUInt16LE(opt) === 0x20b ? opt + 112 : opt + 96;
      bytes.writeUInt32LE(0, dirs + 4 * 8);
      bytes.writeUInt32LE(0, dirs + 4 * 8 + 4);
      const stripped = path.join(
        fs.mkdtempSync(path.join(require("os").tmpdir(), "ttsign-")),
        "stripped-fixture.dll"
      );
      fs.writeFileSync(stripped, bytes);
      const no = hasEmbeddedSignature(stripped);
      if (no.signed) {
        problems.push("the detector called a file with an emptied security directory signed -- it would green-light an unsigned release.");
      }
      try {
        fs.rmSync(path.dirname(stripped), { recursive: true, force: true });
      } catch {
        /* a leftover temp file is not worth failing a gate over */
      }
    }
    rule(0, "the signature detector flags a genuinely signed file and spares an unsigned one", problems);
  }

  // ─── RULE 1 -- all four artifact classes are present ─────────────────────────
  const artifacts = enumerateArtifacts(appDir);
  {
    const problems = artifacts.map((a) => {
      if (!a.file || a.missing || !fs.existsSync(a.file)) {
        return (
          `${a.klass}: ${a.file ? relTo(a.file) : "(unresolved)"} is missing. --post-build was asked ` +
          `for, so this is a FAILURE and not a skip: run \`npx tauri build --bundles nsis\` first. ` +
          `(${a.why})`
        );
      }
      return null;
    });
    rule(
      1,
      `all four artifact classes are present: ${CLASS_MAIN}, ${CLASS_RESOURCES}, ${CLASS_UNINSTALLER}, ${CLASS_INSTALLER}`,
      problems,
      `${artifacts.length} artifact class(es); the paths come from the EMITTED installer script ` +
        `(MAINBINARYSRCPATH and its File /oname= lines), never from convention`
    );
  }

  // ─── RULE 2 -- the signed arm. Bytes only, and measurable only with a certificate. ──────────
  const present = artifacts.filter((a) => a.file && !a.missing && fs.existsSync(a.file));
  const observed = present.map((a) => {
    if (a.kind === "generated-inside-the-installer") {
      const txt = fs.readFileSync(a.file, "utf8");
      const m = txt.match(/^\s*!define\s+UNINSTALLERSIGNCOMMAND\s+"(.*)"\s*$/m);
      return {
        a,
        wired: !!(m && m[1].trim() !== ""),
        carries: null, // NOT a signature verdict. There are no bytes to have one.
        detail: m ? "UNINSTALLERSIGNCOMMAND is defined" : "no UNINSTALLERSIGNCOMMAND define",
      };
    }
    const s = hasEmbeddedSignature(a.file);
    return { a, carries: s.signed, detail: s.reason };
  });

  // Only classes that EXIST AS BYTES can be judged by their bytes. The uninstaller is deliberately
  // not among them; it is reported UNMEASURABLE below, in every configuration, for ever -- there
  // is no build of this project in which a post-build reader can see it.
  const byBytes = observed.filter((o) => o.a.kind === "pe");
  const generated = observed.filter((o) => o.a.kind === "generated-inside-the-installer");

  const unmeasurable = [];
  if (thumbprint !== null) {
    rule(
      2,
      "every artifact class that exists AS BYTES carries an Authenticode signature",
      byBytes.map((o) =>
        o.carries
          ? null
          : `${o.a.klass}: ${relTo(o.a.file)} carries no signature (${o.detail}), though a certificate IS configured.`
      ),
      `${byBytes.length} class(es) read from the bytes the emitted installer script packs; ` +
        `${generated.length} generated inside the installer and reported UNMEASURABLE`
    );
  } else {
    unmeasurable.push({
      id: 2,
      title: "every artifact class that exists AS BYTES carries an Authenticode signature",
      why:
        `No certificate is configured (${ENV_THUMBPRINT} is unset), so nothing was signed and this ` +
        `rule has nothing to measure. It is NOT a green tick and must never be reported as one -- ` +
        `per D-01 no certificate exists in this phase at all. The day one is configured, this rule ` +
        `starts asserting and this line disappears.`,
    });
  }

  // ─── RULE 3 -- the uninstaller's sign command is WIRED. Necessary, never sufficient. ────────
  // Split out of rule 2 because it is a different kind of fact. Its ABSENCE is a real defect the
  // gate can prove: with no UNINSTALLERSIGNCOMMAND, no certificate on earth reaches the
  // uninstaller. Its PRESENCE proves nothing -- the bundler emits that define from
  // `bundle.windows.signCommand` whether or not a certificate exists, which is exactly how it came
  // to stand in for evidence in a build where nothing was signed (WS4 finding 2, defect A).
  {
    const problems = [];
    if (!generated.length) {
      problems.push(
        `${CLASS_UNINSTALLER}: the emitted installer script is absent, so the sign-command wiring ` +
          `cannot be read at all. --post-build was asked for: run \`npx tauri build --bundles nsis\` first.`
      );
    }
    for (const o of generated) {
      if (!o.wired) {
        problems.push(
          `${CLASS_UNINSTALLER}: ${relTo(o.a.file)} has no UNINSTALLERSIGNCOMMAND (${o.detail}). ` +
            `NSIS signs the uninstaller through that define and nothing else, so the uninstaller ` +
            `inside the installer can never be signed, certificate or not.`
        );
      }
    }
    rule(
      3,
      "the uninstaller's sign command is wired into the emitted installer script (necessary, never sufficient)",
      problems,
      "the bundler emits this define from bundle.windows.signCommand unconditionally, so its " +
        "presence is a precondition and NOT evidence that anything was signed"
    );
  }

  // The uninstaller's own signature: unmeasurable by construction, in every configuration.
  unmeasurable.push({
    id: "-",
    title: `${CLASS_UNINSTALLER} carries an Authenticode signature`,
    why:
      "NSIS generates and signs the uninstaller INSIDE the installer through !uninstfinalize, so " +
      "no uninstaller file exists on disk for this gate to read. The only post-build fact " +
      "available is whether the sign command was wired (rule 3), and a config-emitted define is " +
      "not evidence of a signature. Proving this class needs the installer to be run, which this " +
      "gate will not do.",
  });

  // ─── report ────────────────────────────────────────────────────────────────
  for (const r of results) {
    log(`${r.bad.length ? "FAIL" : "PASS"}  rule ${r.id}  ${r.title}`);
    for (const p of r.bad) log(`        ${p}`);
    if (r.note && !r.bad.length) log(`        (${r.note})`);
  }
  for (const u of unmeasurable) {
    log(`UNMEASURABLE  rule ${u.id}  ${u.title}`);
    log(`        ${u.why}`);
  }

  log("");
  log("  artifact classes:");
  for (const o of observed) {
    // The uninstaller gets a verdict of its own, and it is not a signature verdict. Saying
    // "carries a signature" about a config-emitted define is a claim the gate cannot support --
    // that claim is the defect this section was rewritten to remove.
    const verdict =
      o.a.kind === "generated-inside-the-installer"
        ? o.wired
          ? "UNMEASURABLE (sign command wired, which is a precondition and not evidence)"
          : "UNMEASURABLE, and the sign command is NOT wired -- see rule 3"
        : o.carries
          ? "carries a signature"
          : "no signature";
    log(`    ${o.a.klass}: ${relTo(o.a.file)} -- ${verdict} (${o.detail})`);
    // Where the packed path and the conventional one disagree, say so. Reading the conventional
    // path was defect B, and a disagreement printed here is what would have caught it.
    if (o.a.guessed && path.resolve(o.a.guessed) !== path.resolve(o.a.file)) {
      log(
        `      NOTE: convention would have read ${relTo(o.a.guessed)}, which is NOT what ships. ` +
          `Judged from ${o.a.why}.`
      );
    }
  }
  log("");
  if (thumbprint === null) {
    log(`  signing   : UNSIGNED by configuration. ${ENV_THUMBPRINT} is unset, so this build was never`);
    log("              going to sign anything, and the artifacts above confirm it did not.");
  } else {
    log("  signing   : a certificate IS configured, so every class that EXISTS AS BYTES was required to");
    log("              carry a signature and the rule was asserted against those bytes. The uninstaller");
    log("              is not one of them and was not asserted -- see UNMEASURABLE above.");
  }
  const measurable = results.length;
  log(
    `  rules     : ${measurable - failures}/${measurable} measurable rule(s) passed` +
      `, ${unmeasurable.length} UNMEASURABLE`
  );
  if (failures) {
    log("RESULT: FAILURE");
    return 1;
  }
  if (unmeasurable.length) {
    log(
      `RESULT: the measurable rules hold; ${unmeasurable.length} arm(s) were NOT measured ` +
        "(see UNMEASURABLE above)."
    );
    return 0;
  }
  log("RESULT: PASS");
  return 0;
}

// ─── entry point ───────────────────────────────────────────────────────────────
function main(argv, env) {
  const postArgs = argv.filter((a) => a === "--post-build" || a.startsWith("--post-build="));
  if (postArgs.length > 0) {
    const inline = postArgs.map((a) => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : null)).find(Boolean);
    const positional = argv.filter((a) => !a.startsWith("--"))[0] || null;
    return runPostBuild({
      root: ROOT,
      given: inline || positional,
      env,
      log: (m) => process.stdout.write(`${m}\n`),
    });
  }

  const artifact = argv.filter((a) => !a.startsWith("--"))[0];
  if (!artifact) {
    process.stderr.write(
      "sign-windows-artifact: no artifact path given. The bundler passes one through the %1 " +
        "placeholder in bundle.windows.signCommand. This is the gate failing to RUN, which is " +
        "deliberately distinct from both success and a rule failure.\n"
    );
    process.exit(2);
  }
  return runSign({ artifact, env });
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2), process.env));
}

module.exports = {
  ENV_THUMBPRINT,
  ENV_TIMESTAMP,
  ENV_SIGNTOOL,
  DEFAULT_TIMESTAMP_URL,
  configuredThumbprint,
  hasEmbeddedSignature,
  runSign,
  runPostBuild,
  enumerateArtifacts,
  CLASS_MAIN,
  CLASS_RESOURCES,
  CLASS_UNINSTALLER,
  CLASS_INSTALLER,
};

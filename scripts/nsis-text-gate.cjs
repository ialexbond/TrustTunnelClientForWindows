/*
 * nsis-text-gate.cjs — the installer's Russian, guarded at the byte level.
 *
 * WHY THIS EXISTS
 *   makensis 3.11 (the Unicode build Tauri manages at %LOCALAPPDATA%\tauri\NSIS) decides a
 *   script's encoding by BOM alone for the file it is handed on the COMMAND LINE: no BOM means
 *   the machine's ANSI codepage, with no UTF-8 sniffing, even when the file is byte-valid UTF-8.
 *   The result is mojibake in the installer, exit code 0, zero warnings — and /WX does not
 *   escalate it, because there is no warning to escalate. That is why this gate reads bytes
 *   instead of grepping a build log.
 *
 *   Files reached by !include are different: they are decoded as UTF-8 with or without a BOM,
 *   and invalid UTF-8 is a hard "Bad text encoding" abort. That is why Russian.nsh works today
 *   with no BOM, and why the rules below are DIRECTIONAL — the required encoding follows from
 *   WHO reads the file, not from taste. Anything that flattens that into "add BOMs everywhere"
 *   is wrong twice over: Tauri prepends its own BOM to what it writes, and a doubled BOM is a
 *   hard abort ("Error in script ... on line 1").
 *
 * NO RULE HERE IS ALLOWED TO PASS VACUOUSLY
 *   Every path comes from tauri.conf.json, never from convention: a rule that checks a file no
 *   build references is a green tick over nothing. A configured file that is missing is a
 *   FAILURE, not a skip. And rule 0 runs the mojibake detector against fixtures on every
 *   invocation, so a detector that has been broken into inertness turns the gate RED instead of
 *   reporting all-clear. Three separate drafts of this gate died of exactly that defect.
 *
 * Invoked as: node scripts/nsis-text-gate.cjs [--post-build[=<app>]] [repo-root]
 *   default      — source files, plus rules 10 and 13 WHENEVER a current emitted script happens to
 *                  be on disk. Runs anywhere; on a tree that has never built, those two say
 *                  «CANNOT MEASURE» through the warning channel and are not counted as passing
 *                  rules. Rule 12 needs no build at all and always runs.
 *   --post-build — additionally asserts what the bundler actually emitted (rules 9, 10 and 13).
 *                  Hard-fails when the artifact is absent or stale, so it can never be a silent
 *                  no-op. Run it after `npx tauri build --bundles nsis`, before handing anyone an
 *                  installer — `npm run nsis:check:post` is that invocation, and rule 11 is what
 *                  keeps it from disappearing again.
 * Exit: 0 all rules pass, 1 at least one FAIL, 2 the gate itself could not run.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const postBuildArgs = args.filter((a) => a === "--post-build" || a.startsWith("--post-build="));
const POST_BUILD = postBuildArgs.length > 0;
// Which edition's build artifact to assert. Pro is what ships; Light is parked, and its CI job
// was removed for the same reason. Named explicitly rather than "whichever target/ happens to
// exist", because "the artifact was not there so we passed" is the vacuum this gate exists to
// avoid.
//
// It is spelled as its own constant because rule 10 needs the same default WITHOUT --post-build:
// that rule's availability is decided by the ARTIFACT rather than by the flag, so it cannot read
// its subject off `postBuildArgs` the way rule 9 does.
const DEFAULT_BUILT_APP = "gui-pro/src-tauri";
const BUILT_APPS = postBuildArgs
  .map((a) => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : DEFAULT_BUILT_APP))
  .filter((v, i, all) => all.indexOf(v) === i);
const ROOT = args.filter((a) => !a.startsWith("--"))[0] || path.join(__dirname, "..");

// Each entry is one Tauri app whose config drives everything the gate looks at.
const APPS = ["gui-pro/src-tauri", "gui-light/src-tauri"]
  .map((p) => path.join(ROOT, p))
  .filter((p) => fs.existsSync(path.join(p, "tauri.conf.json")));

const results = [];
let failures = 0;
let warnings = 0;

function rule(id, title, problems, note) {
  const bad = problems.filter(Boolean);
  if (bad.length) failures++;
  results.push({ id, title, bad, note });
}
function warn(msg) {
  warnings++;
  results.push({ warn: msg });
}
function die(msg) {
  console.error(`nsis-text-gate: ${msg}`);
  process.exit(2);
}

// ─── byte helpers ──────────────────────────────────────────────────────────────
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const hasBom = (b) => b.length >= 3 && b.subarray(0, 3).equals(BOM);
const hasDoubleBom = (b) => hasBom(b) && b.length >= 6 && b.subarray(3, 6).equals(BOM);
const hasUtf16Bom = (b) =>
  b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff));
const body = (b) => (hasBom(b) ? b.subarray(3) : b);
const utf8Strict = new TextDecoder("utf-8", { fatal: true });
function decodeUtf8(b) {
  try {
    return utf8Strict.decode(b);
  } catch {
    return null;
  }
}
const countNonAscii = (b) => {
  let n = 0;
  for (const byte of b) if (byte > 127) n++;
  return n;
};
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");

// ─── the mojibake detector ─────────────────────────────────────────────────────
// Encoding rules cannot catch text that is ALREADY double-encoded: such a file is valid UTF-8,
// takes a BOM happily, compiles with exit 0 and zero warnings, and ships the garbage. Only
// reading the content catches it — and the test must be a DECODER, never a pattern. A character
// class like /[РС][Ѐ-ӿ]/ either cannot fire at all or flags the ordinary word «Рекомендуется»;
// both variants have been shipped in drafts of this gate.
//
// Granularity is one RUN of adjacent non-ASCII characters, not one line and not one file.
// Coarser granularity is silently vacuous on the realistic case — a single pasted word among
// correct Russian — because the genuine Russian around it encodes to bytes that are not valid
// UTF-8, so the precondition dies and the check reports clean.
const SINGLE_BYTE = ["windows-1251", "windows-1252", "iso-8859-1"];
const encoders = new Map();
for (const enc of SINGLE_BYTE) {
  let dec;
  try {
    dec = new TextDecoder(enc, { fatal: false });
  } catch {
    die(`this Node has no '${enc}' decoder — the double-encoding rule cannot run, and a gate ` +
        `that cannot run its own rule must not report success`);
  }
  const map = new Map();
  for (let i = 0; i < 256; i++) {
    const ch = dec.decode(Uint8Array.of(i));
    if (ch !== "\uFFFD" && !map.has(ch)) map.set(ch, i);
  }
  encoders.set(enc, map);
}
function encodeSingleByte(text, map) {
  const out = Buffer.alloc(text.length);
  let i = 0;
  for (const ch of text) {
    if (ch.length > 1) return null; // astral char: not representable, not our failure mode
    const b = map.get(ch);
    if (b === undefined) return null;
    out[i++] = b;
  }
  return out.subarray(0, i);
}
/** @returns {{enc:string, fixed:string}|null} */
function detectDoubleEncoded(run) {
  for (const enc of SINGLE_BYTE) {
    const bytes = encodeSingleByte(run, encoders.get(enc));
    if (!bytes || bytes.length === 0) continue;
    const decoded = decodeUtf8(bytes);
    if (decoded === null || decoded === run) continue;
    if (!/[Ѐ-ӿ]/.test(decoded)) continue; // must resolve to Cyrillic, or it is noise
    return { enc, fixed: decoded };
  }
  return null;
}
function scanForMojibake(file, text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/[^\x00-\x7f]+/g)) {
      const hit = detectDoubleEncoded(m[0]);
      if (hit) {
        out.push(
          `${rel(file)}:${i + 1} — «${m[0]}» is Cyrillic that has been through ${hit.enc} twice; ` +
            `it should read «${hit.fixed}»`
        );
      }
    }
  });
  return out;
}

// ─── RULE 0 — the detector is alive ────────────────────────────────────────────
// Fixtures, not faith. If this rule ever fails, every "no mojibake found" verdict this gate has
// ever printed is worthless, so it runs first and on every invocation.
{
  const problems = [];
  // Fixtures are BUILT, not typed: decoding the UTF-8 bytes of a known word with each
  // single-byte codec produces the exact mojibake that codec produces in the wild. Typing the
  // visible form by hand loses the invisible C1 control characters (0x81, 0x8D, 0x90 ...) the
  // Latin-1 flavour is full of — an earlier draft of this rule failed for exactly that reason,
  // and it was the FIXTURE that was wrong, not the detector.
  const SAMPLE = "\u0423\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u044c"; // «Установить»
  const sampleBytes = Buffer.from(SAMPLE, "utf8");
  const mustFlag = SINGLE_BYTE.map((enc) => {
    const garbled = new TextDecoder(enc, { fatal: false }).decode(sampleBytes);
    if (garbled.includes("\uFFFD")) {
      die("cannot build a " + enc + " fixture for rule 0 - refusing to run a detector nothing checks");
    }
    return [garbled, enc];
  });
  const mustNotFlag = [
    "Установить",
    "Рекомендуется", // starts Р + Cyrillic: the shape a naive regex false-flags
    "Мёд, ёж, Ъ, Ы — тире и «кавычки»",
    "Refreshing icon cache...",
  ];
  for (const [s, enc] of mustFlag) {
    const hit = detectDoubleEncoded(s);
    if (!hit) problems.push(`detector missed known ${enc} mojibake «${s}» — it is inert`);
  }
  for (const s of mustNotFlag) {
    const hit = detectDoubleEncoded(s);
    if (hit) problems.push(`detector false-flagged legitimate text «${s}» as ${hit.enc} mojibake`);
  }
  rule(0, "the mojibake detector flags known mojibake and spares legitimate Russian", problems);
}

if (APPS.length === 0) {
  die(`no tauri.conf.json found under ${ROOT} — the gate has no subject and refuses to report success`);
}

// ─── collect the subject set from the CONFIG, never from convention ────────────
// A rule aimed at a filename the build does not reference is a green tick over nothing: a fork
// named installer.template.nsi with `Unicode false` in it would sail past a gate that checks
// nsis/installer.nsi, and artwork nothing references would satisfy a gate that only checks the
// file exists.
const subjects = []; // {app, role, file, key}
const missing = [];
for (const app of APPS) {
  let conf;
  try {
    conf = JSON.parse(fs.readFileSync(path.join(app, "tauri.conf.json"), "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    missing.push(`${rel(path.join(app, "tauri.conf.json"))} — cannot be parsed: ${e.message}`);
    continue;
  }
  const nsis = conf?.bundle?.windows?.nsis;
  if (!nsis) {
    missing.push(`${rel(app)}/tauri.conf.json has no bundle.windows.nsis — nothing to guard, ` +
                 `which means either the config moved or this gate is pointed at the wrong app`);
    continue;
  }
  const add = (role, value, key) => {
    if (!value) return;
    const file = path.join(app, value);
    if (!fs.existsSync(file)) {
      missing.push(`${rel(app)}/tauri.conf.json sets ${key} = "${value}", but that file does not exist`);
      return;
    }
    subjects.push({ app, role, file, key });
  };
  add("hooks", nsis.installerHooks, "nsis.installerHooks");
  add("template", nsis.template, "nsis.template");
  for (const [lang, p] of Object.entries(nsis.customLanguageFiles || {})) {
    add("language", p, `nsis.customLanguageFiles.${lang}`);
  }
  // The BRANDING assets are checked for EXISTENCE only, and deliberately never enter `subjects`.
  //
  // Why they belong in this gate at all: their failure mode is the same silent one every rule here
  // exists for. A configured bitmap path that does not resolve makes the bundler fall back to the
  // toolkit's stock artwork — the build stays green, exits 0, warns about nothing, and the only
  // symptom is somebody else's blue picture on our installer, which nobody looks at once the
  // pipeline is trusted. Rule 1 already says «every NSIS path in tauri.conf.json resolves to a file
  // that exists»; before this, three of those paths were exempt from the sentence.
  //
  // Why they must NOT be scanned as text: rules 2 and 8 decode their subjects as UTF-8. A .bmp or
  // an .ico is not UTF-8, so adding them to `subjects` would fail rule 2 permanently — and the
  // usual repair for a rule that cries wolf is to delete the rule. Existence is the whole of what
  // is checkable here; the pixels are an eye check the gate cannot do and does not pretend to.
  for (const [key, value] of [
    ["nsis.headerImage", nsis.headerImage],
    ["nsis.sidebarImage", nsis.sidebarImage],
    ["nsis.installerIcon", nsis.installerIcon],
  ]) {
    if (!value) continue;
    if (!fs.existsSync(path.join(app, value))) {
      missing.push(`${rel(app)}/tauri.conf.json sets ${key} = "${value}", but that file does not exist`);
    }
  }
  // Anything else with an NSIS extension sitting in the same folders: a throwaway probe, a
  // half-finished fork. Not referenced by the config, so it is a STANDALONE script — the class
  // that makensis reads directly, and the class the probe belonged to.
  const dirs = new Set(subjects.filter((s) => s.app === app).map((s) => path.dirname(s.file)));
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (!/\.(nsi|nsh)$/i.test(name) || !fs.statSync(file).isFile()) continue;
      if (subjects.some((s) => s.file === file)) continue;
      subjects.push({ app, role: "standalone", file, key: "(not referenced by tauri.conf.json)" });
    }
  }
}
rule(1, "every NSIS path in tauri.conf.json resolves to a file that exists", missing);
if (subjects.length === 0) {
  die("the config named no NSIS files at all — refusing to report success over an empty set");
}

// Read every subject once.
for (const s of subjects) {
  s.bytes = fs.readFileSync(s.file);
  s.text = decodeUtf8(body(s.bytes));
  s.nonAscii = countNonAscii(body(s.bytes));
}

// ─── RULE 2 — valid UTF-8 ──────────────────────────────────────────────────────
rule(
  2,
  "every NSIS file that reaches the installer is valid UTF-8",
  subjects.map((s) => {
    if (hasUtf16Bom(s.bytes)) {
      return `${rel(s.file)} is UTF-16. It compiles, but this project standardises on UTF-8 — ` +
             `re-save it, or delete this clause and say why.`;
    }
    if (s.text === null) {
      return `${rel(s.file)} is not valid UTF-8 (a file saved in the system codepage looks like ` +
             `this). makensis aborts on it with "Bad text encoding".`;
    }
    return null;
  }),
  `${subjects.length} file(s) scanned`
);

// ─── how many template subjects rules 3 and 4 actually have ───────────────────
// Both rules below filter `subjects` down to role "template", and with no fork configured that
// filter is EMPTY — so both print a green «PASS» over zero files. That is the exact shape this
// gate's own header calls a green tick over nothing, and it is worse here than elsewhere: rule 4
// prints the sentence «the forked template is pure ASCII» whether or not a forked template exists,
// which reads to anybody scanning the report as a checked fact.
//
// It is deliberately NOT made a failure. Phase 32's owner decided the narrow fork does not ship
// (task 32-08/1, reversing phase 31's D-01), so «no template» is the CORRECT configuration and a
// gate that failed on it would be a rule demanding a fork nobody wants. What was missing is the
// report saying so out loud, so the two rules now carry a note naming their subject count — and,
// when that count is zero, saying plainly that the PASS asserts nothing.
const templateSubjects = subjects.filter((s) => s.role === "template");
const TEMPLATE_NOTE = templateSubjects.length
  ? `${templateSubjects.length} forked template(s): ${templateSubjects.map((s) => rel(s.file)).join(", ")}`
  : `nsis.template is UNCONFIGURED in every app scanned — this rule has NO template subject and ` +
    `its PASS asserts nothing about one. That is the intended state: the narrow template fork was ` +
    `decided against, so there is no forked script to hold to these byte rules. Configure ` +
    `bundle.windows.nsis.template and the rule acquires a subject automatically.`;

// ─── RULE 3 — files the BUNDLER rewrites must carry NO BOM ─────────────────────
// Measured: source Russian.nsh is 3995 bytes starting `4c 61 6e`; the copy the bundler writes
// into target/release/nsis/x64 is 3998 bytes starting `ef bb bf 4c 61 6e` and byte-identical
// after that. Tauri's writer stamps the BOM. Add one here and the copy gets two, and a doubled
// BOM is a hard abort. The forked template goes in this same bucket: Tauri renders and rewrites
// it exactly like a language file — Tauri's own built-in template carries no BOM either.
rule(
  3,
  "files the bundler rewrites (customLanguageFiles, nsis.template) carry NO BOM",
  subjects
    .filter((s) => s.role === "language" || s.role === "template")
    .map((s) =>
      hasBom(s.bytes)
        ? `${rel(s.file)} (${s.key}) carries a UTF-8 BOM. Tauri prepends a second one when it ` +
          `writes the build copy, and the doubled BOM aborts makensis on line 1.`
        : null
    ),
  // This rule DOES have language-file subjects, so its PASS is not empty — but the template half
  // of it is, and the note says which half was actually exercised.
  `${subjects.filter((s) => s.role === "language").length} language file(s) checked. ${TEMPLATE_NOTE}`
);

// ─── RULE 4 — the forked template stays ASCII ──────────────────────────────────
// The one thing nobody has been able to observe yet is whether Tauri stamps its BOM when
// rendering a CUSTOM template — the built-in path is proved, the custom path is inference. An
// ASCII template makes that question harmless: ASCII decodes identically as UTF-8 and as any
// ANSI codepage, so the fork cannot garble either way. All user-visible text belongs in the
// language files as LangStrings regardless, because English users read the same installer.
rule(
  4,
  "the forked template is pure ASCII (all user-visible text lives in the language files)",
  subjects
    .filter((s) => s.role === "template")
    .map((s) =>
      s.nonAscii > 0
        ? `${rel(s.file)} holds ${s.nonAscii} non-ASCII byte(s). Move the text into ` +
          `nsis/Russian.nsh as a LangString and reference it as $(name). Keeping the template ` +
          `ASCII is what makes it safe whether or not Tauri BOMs a custom template.`
        : null
    ),
  TEMPLATE_NOTE
);

// ─── RULE 5 — nothing declares `Unicode false` ─────────────────────────────────
// Corrected from an earlier draft: `Unicode true` is a NO-OP on makensis 3.11 — Unicode is
// already the default, and scripts with and without the line compile byte-identically. So its
// ABSENCE is not a defect and must not fail a build. An explicit `Unicode false` is: it flips
// every !include to the ANSI codepage, and the Russian survives only as mojibake.
{
  const problems = [];
  for (const s of subjects) {
    if (s.text && /^[ \t]*Unicode[ \t]+false\b/im.test(s.text)) {
      problems.push(
        `${rel(s.file)} declares «Unicode false» — every !include is then read as the system ` +
          `ANSI codepage and the Russian ships garbled, with exit 0 and no warning.`
      );
    }
  }
  const tpl = subjects.find((s) => s.role === "template");
  if (tpl && tpl.text && !/^[ \t]*Unicode[ \t]+true\b/im.test(tpl.text)) {
    warn(
      `${rel(tpl.file)} does not state «Unicode true». Harmless on makensis 3.11 (Unicode is the ` +
        `default there, proved byte-identical), so this is a warning, not a failure — but the ` +
        `built-in template states it explicitly and a fork is cheaper to read if it does too.`
    );
  }
  rule(5, "no NSIS file declares «Unicode false»", problems);
}

// ─── RULE 6 — Russian in the hooks file stays inside comments ──────────────────
// installer-hooks.nsh is the one file with no protective layer: the generated script !includes
// it by ABSOLUTE SOURCE PATH, so nothing copies it and nothing adds a BOM to it. Every one of its
// non-ASCII bytes is inside a `;` comment, and since 32-FIX-18 every DetailPrint is a bare
// `$(name)` reference (G-32-6 moved the last four English literals into the language files), so a
// decoding regression here is invisible. The day someone writes a Russian DetailPrint it becomes
// the first user-visible casualty — and it would also be untranslatable.
rule(
  6,
  "non-ASCII in installerHooks stays inside comments (user text belongs in the language files)",
  subjects
    .filter((s) => s.role === "hooks" && s.text !== null)
    .flatMap((s) =>
      s.text.split(/\r?\n/).map((line, i) =>
        /[^\x00-\x7f]/.test(line) && !/^\s*;/.test(line)
          ? `${rel(s.file)}:${i + 1} has non-ASCII outside a comment: ${line.trim().slice(0, 90)}\n` +
            `      This file is included by absolute source path and never gets a BOM. Put the ` +
            `text in nsis/Russian.nsh as a LangString and use $(name).`
          : null
      )
    )
);

// ─── RULE 7 — a standalone .nsi carrying non-ASCII carries a BOM ───────────────
// THE INCIDENT RULE. A .nsi handed straight to makensis with no BOM is decoded with the
// machine's ANSI codepage — silently, exit 0, no warning, /WX useless. This is the only silent
// regime that exists, and it is the one a throwaway probe lands in.
rule(
  7,
  "a standalone .nsi carrying non-ASCII carries a UTF-8 BOM",
  subjects
    .filter((s) => s.role === "standalone" && /\.nsi$/i.test(s.file))
    .map((s) =>
      s.nonAscii > 0 && !hasBom(s.bytes)
        ? `${rel(s.file)} holds ${s.nonAscii} non-ASCII byte(s) and no BOM. Compiled directly by ` +
          `makensis it is read as the machine's ANSI codepage: silent mojibake, exit 0, no ` +
          `warning. Save it as UTF-8 with BOM, or compile it with /INPUTCHARSET UTF8.`
        : null
    ),
  "standalone = an .nsi in the nsis folder that tauri.conf.json does not reference"
);

// ─── RULE 8 — nothing is already double-encoded ────────────────────────────────
const scanned = subjects.filter((s) => s.text !== null);
rule(
  8,
  "no already-double-encoded text in anything reaching the installer",
  scanned.flatMap((s) => scanForMojibake(s.file, s.text)),
  `${scanned.length} file(s) scanned. Catches text that went through the wrong codepage BEFORE ` +
    `it was saved — invisible to every other rule here, because such a file is valid UTF-8, ` +
    `takes a BOM, and compiles clean.`
);

// ─── RULE 9 — what the bundler actually emitted (--post-build only) ────────────
// Rules 1-8 read intent from source. This one reads the script the compiler was handed. It is
// the only check that can close the one open question — whether Tauri stamps its BOM when it
// renders a CUSTOM template — so it must never pass by absence.
if (POST_BUILD) {
  const problems = [];
  for (const relApp of BUILT_APPS) {
    const app = path.join(ROOT, relApp);
    if (!APPS.includes(app)) {
      problems.push(`--post-build names ${relApp}, which has no tauri.conf.json`);
      continue;
    }
    const gen = path.join(app, "target", "release", "nsis", "x64", "installer.nsi");
    if (!fs.existsSync(gen)) {
      problems.push(
        `${rel(gen)} is missing. --post-build was asked for, so this is a FAILURE and not a ` +
          `skip: run \`npx tauri build --bundles nsis\` first, or drop --post-build.`
      );
      continue;
    }
    const b = fs.readFileSync(gen);
    if (!hasBom(b)) {
      problems.push(
        `${rel(gen)} does not start with EF BB BF. It is the file makensis is handed, so with no ` +
          `BOM it is decoded with the machine's ANSI codepage. If a custom template is now ` +
          `configured, this is the failure that question was about: give the template a BOM, or ` +
          `keep every non-ASCII character out of it.`
      );
    }
    if (hasDoubleBom(b)) {
      problems.push(`${rel(gen)} starts with TWO BOMs — makensis aborts on line 1.`);
    }
    const txt = decodeUtf8(body(b));
    if (txt === null) problems.push(`${rel(gen)} is not valid UTF-8.`);
    else if (/^[ \t]*Unicode[ \t]+false\b/im.test(txt)) {
      problems.push(`${rel(gen)} declares «Unicode false» — the compiled installer is ANSI.`);
    }
    // The emitted language files must equal their sources apart from the injected BOM.
    for (const s of subjects.filter((x) => x.app === app && x.role === "language")) {
      const emitted = path.join(path.dirname(gen), path.basename(s.file));
      if (!fs.existsSync(emitted)) {
        problems.push(`${rel(emitted)} was never emitted, though ${s.key} names it.`);
        continue;
      }
      const e = fs.readFileSync(emitted);
      if (Buffer.compare(body(e), body(s.bytes)) !== 0) {
        problems.push(
          `${rel(emitted)} differs from ${rel(s.file)} by more than the BOM — something rewrote ` +
            `the text on the way into the build.`
        );
      }
      const et = decodeUtf8(body(e));
      if (et !== null) problems.push(...scanForMojibake(emitted, et));
      if (et !== null && /Russian/i.test(path.basename(emitted)) && !/[Ѐ-ӿ]/.test(et)) {
        problems.push(`${rel(emitted)} contains no Cyrillic at all.`);
      }
    }
  }
  rule(9, "the emitted installer.nsi carries a BOM, is Unicode, and matches its sources", problems);
}

// ─── THE SUBJECT SHARED BY EVERY RULE THAT READS BUILD OUTPUT ──────────────────────────────────
//
// WHY THIS IS ONE FUNCTION AND NOT TWO COPIES. Rules 10 and 13 both assert facts that exist ONLY
// in the script the compiler was handed, and both therefore have to answer the same question
// first: is there a current artifact to assert over at all? Written twice, the two answers drift,
// and the drift is invisible — a rule whose triage has quietly become "file missing, nothing to
// say" prints exactly the same silence as a rule that measured and found nothing wrong. That is
// the failure this whole gate exists to refuse, so the triage lives in ONE place.
//
// THE THREE OUTCOMES, and each one exists because the alternative is a lie:
//   (i)   READY  — a current artifact, rendered against THIS tree's hook. The only state in which
//         a caller may report a pass.
//   (ii)  ABSENT — no artifact. Under --post-build that is a FAILURE, because the flag is a claim
//         that a build just happened. Without the flag it is an honest CANNOT MEASURE through the
//         warning channel, which is not counted as a passing rule.
//   (iii) STALE  — an artifact older than the hook file. Neither a pass nor a violation: an
//         assertion over a render from before the current hook says nothing about the current
//         hook. This is the clause that keeps «the assertion held» separable from «there was
//         nothing current to assert over».
// Plus two integrity checks that would otherwise judge the wrong file: an artifact that does not
// !include the configured hook at all, and one rendered in a DIFFERENT CHECKOUT (the emitted
// script names its hook by absolute path, so this is decidable rather than assumed).
//
// @returns {{state:"ready", gen:string, genText:string, lines:string[], includedHook:string,
//            hookText:string, hookLines:string[]}|{state:"unavailable"}}
function emittedScriptSubject(o) {
  const { ruleId, app, hooks, cannotRead, staleClause, problems } = o;
  const gen = path.join(app, "target", "release", "nsis", "x64", "installer.nsi");
  const unavailable = (why, postSuffix) => {
    if (POST_BUILD) problems.push(`${why} ${postSuffix}`);
    else warn(`rule ${ruleId} — CANNOT MEASURE: ${why}`);
    return { state: "unavailable" };
  };

  if (!fs.existsSync(gen)) {
    return unavailable(
      `${rel(gen)} is absent, so ${cannotRead} cannot be read. Run ` +
        `\`npx tauri build --bundles nsis\` first.`,
      `--post-build was asked for, so this is a FAILURE and not a skip.`
    );
  }

  const genTime = fs.statSync(gen).mtime;
  const hookTime = fs.statSync(hooks.file).mtime;
  if (genTime < hookTime) {
    return unavailable(
      `${rel(gen)} (${genTime.toISOString()}) is OLDER than ${rel(hooks.file)} ` +
        `(${hookTime.toISOString()}) — it was rendered from a previous version of the hook, so ` +
        `${staleClause}. Rebuild before measuring.`,
      `--post-build was asked for, so a stale artifact is a FAILURE.`
    );
  }

  const genText = decodeUtf8(body(fs.readFileSync(gen)));
  if (genText === null) {
    problems.push(`${rel(gen)} is not valid UTF-8, so ${cannotRead} cannot be read.`);
    return { state: "unavailable" };
  }
  const lines = genText.split(/\r?\n/);

  // The emitted script names the hook file it was rendered against, by absolute path. Reading
  // THAT path rather than the configured one is what makes the comparison honest: an artifact
  // rendered in a different checkout would otherwise be judged against this checkout's hook.
  const includeLine = lines.find(
    (l) => /^\s*!include\s+"/.test(l) && path.basename(l.split('"')[1] || "") === path.basename(hooks.file)
  );
  if (!includeLine) {
    problems.push(
      `${rel(gen)} does not !include ${path.basename(hooks.file)} at all — the hook the ` +
        `configuration names never reached the compiler.`
    );
    return { state: "unavailable" };
  }
  const includedHook = includeLine.split('"')[1];
  if (path.resolve(includedHook) !== path.resolve(hooks.file)) {
    problems.push(
      `${rel(gen)} was rendered against ${includedHook}, not against ${rel(hooks.file)}. The ` +
        `artifact belongs to another checkout; measuring it would judge a file this tree does ` +
        `not own.`
    );
    return { state: "unavailable" };
  }

  const hookText = fs.readFileSync(includedHook, "utf8").replace(/^﻿/, "");
  return {
    state: "ready",
    gen,
    genText,
    lines,
    includedHook,
    hookText,
    hookLines: hookText.split(/\r?\n/),
  };
}

// ─── RULE 10 — the pre-install hook closes the app before the script removes anything ──────────
//
// WHY THIS RULE LIVES HERE AND NOT IN RUST, where every other NSIS contract in this project lives.
// `lifecycle.rs` pins the hook with `include_str!`, which can only reach git-tracked source. The
// fact that matters here is CROSS-FILE and lives in build output: the Tauri template expands
// `NSIS_HOOK_PREINSTALL` at `installer.nsi:614` — THREE LINES ABOVE its own `!insertmacro
// CheckIfAppIsRunning` at `:617`. The generated script is not tracked, so no Rust test can open it,
// and that is exactly why nothing in this repository had ever measured the one thing that decided
// the outcome. On a real Windows install nine `Delete` statements ran against a live install:
// `trusttunnel.exe`, `trusttunnel_client.exe` and `wintun.dll` survived, because NSIS `Delete` on a
// file a process has mapped fails SILENTLY, next to the plaintext credential store (UAT G-32-2).
//
// WHAT IS MEASURED. The Install section of the EMITTED script, with the hook macro EXPANDED at its
// insertion point — because the emitted script only `!include`s the hook file and inserts the macro
// by name, so neither file alone carries the answer. In that composite, the first termination step
// must precede the first `Delete`. The template's own `:617` insertion therefore cannot satisfy the
// rule on its own: it sits BELOW the expansion, and its position is the whole defect.
//
// AVAILABILITY IS DECIDED BY THE ARTIFACT, NOT BY THE FLAG — deliberately, and it is the difference
// between a rule and a decoration. Rule 9 has been `--post-build`-only since it was written, and
// nothing in this repository has ever passed that flag: not `frontend.yml`, not `package.json`, not
// `prerelease`. It has consequently never run in a standing gate. A rule 10 wired the same way would
// print nothing forever in every mode anyone actually uses.
{
  const ORDERING_APPS = POST_BUILD ? BUILT_APPS : [DEFAULT_BUILT_APP];
  const problems = [];
  let measured = 0;

  // The statements of one NSIS region, prose and blank lines removed — the same normalisation the
  // Rust arm uses, so the two halves of this contract agree on what a "statement" is.
  const statements = (lines) =>
    lines.map((l) => l.trim()).filter((l) => l && !l.startsWith(";"));

  const isTermination = (s) => {
    const [a, b] = s.split(/\s+/);
    return (a === "!insertmacro" && b === "CheckIfAppIsRunning") || a === "nsis_tauri_utils::FindProcess";
  };

  for (const relApp of ORDERING_APPS) {
    const app = path.join(ROOT, relApp);
    if (!APPS.includes(app)) {
      problems.push(`rule 10 names ${relApp}, which has no tauri.conf.json`);
      continue;
    }
    const hooks = subjects.find((s) => s.app === app && s.role === "hooks");
    if (!hooks) {
      problems.push(
        `${rel(app)}/tauri.conf.json configures no nsis.installerHooks, so there is no hook ` +
          `expansion whose ordering could be judged.`
      );
      continue;
    }
    // The three outcomes — READY, ABSENT, STALE — plus the two integrity checks that would
    // otherwise judge the wrong file, all live in `emittedScriptSubject` above. They were written
    // for this rule and are shared with rule 13 so the two can never drift into disagreeing about
    // what «there was nothing current to assert over» means.
    const subject = emittedScriptSubject({
      ruleId: 10,
      app,
      hooks,
      cannotRead: "the ordering of the emitted script",
      staleClause: "its ordering is not this tree's ordering",
      problems,
    });
    if (subject.state !== "ready") continue;
    const { gen, lines, includedHook, hookLines } = subject;

    const sectionStart = lines.findIndex((l) => /^Section\s+Install\b/.test(l));
    if (sectionStart < 0) {
      problems.push(`${rel(gen)} has no \`Section Install\` — the subject of this rule is gone.`);
      continue;
    }
    let sectionEnd = sectionStart + 1;
    while (sectionEnd < lines.length && !/^SectionEnd\b/.test(lines[sectionEnd])) sectionEnd++;
    const section = statements(lines.slice(sectionStart, sectionEnd));

    const insertAt = section.findIndex((s) => {
      const [a, b] = s.split(/\s+/);
      return a === "!insertmacro" && b === "NSIS_HOOK_PREINSTALL";
    });
    if (insertAt < 0) {
      problems.push(
        `${rel(gen)} never inserts NSIS_HOOK_PREINSTALL inside \`Section Install\`, so the hook ` +
          `this rule is about does not run there.`
      );
      continue;
    }

    const macroAt = hookLines.findIndex((l) => l.trim() === "!macro NSIS_HOOK_PREINSTALL");
    if (macroAt < 0) {
      problems.push(`${rel(includedHook)} defines no \`!macro NSIS_HOOK_PREINSTALL\` to expand.`);
      continue;
    }
    let macroEnd = macroAt + 1;
    while (macroEnd < hookLines.length && hookLines[macroEnd].trim() !== "!macroend") macroEnd++;
    const hookBody = statements(hookLines.slice(macroAt + 1, macroEnd));

    // The composite the compiler actually walks: the section with the macro replaced by its body.
    const expanded = [...section.slice(0, insertAt), ...hookBody, ...section.slice(insertAt + 1)];
    const firstRemoval = expanded.findIndex((s) => s.split(/\s+/)[0] === "Delete");
    const firstTermination = expanded.findIndex(isTermination);

    if (firstRemoval < 0) {
      const why =
        `${rel(gen)}'s Install section, with the hook expanded, contains no \`Delete\` at all — ` +
        `there is no removal whose ordering could be judged.`;
      if (POST_BUILD) problems.push(why);
      else warn(`rule 10 — CANNOT MEASURE: ${why}`);
      continue;
    }
    if (firstTermination < 0 || firstTermination > firstRemoval) {
      problems.push(
        `${rel(gen)}: the Install section removes before it closes the application. First ` +
          `\`Delete\` is expanded statement ${firstRemoval} (${expanded[firstRemoval]}); the ` +
          `first termination step is ` +
          (firstTermination < 0
            ? `NOWHERE in the section.`
            : `statement ${firstTermination} (${expanded[firstTermination]}), below it.`) +
          ` WHAT THIS MEANS ON A USER'S DISK: nine files are removed while the program still has ` +
          `its image mapped, NSIS \`Delete\` fails silently on each of them, and three binaries ` +
          `survive in the folder that also holds the user's plaintext credential store — which ` +
          `is precisely what happened on a real Windows install before this rule existed.`
      );
      continue;
    }
    measured++;
  }

  // Emitted only when something was actually measured, or when something failed. A `rule()` call
  // with an empty problem list PRINTS PASS and counts toward «n/n passed»; doing that over an
  // artifact nobody opened is the exact shape rule 0 and rules 3-4 already refuse out loud.
  if (measured > 0 || problems.length) {
    rule(
      10,
      "the pre-install hook closes the app before the emitted script removes anything",
      problems,
      `${measured} emitted script(s) measured, hook macro expanded at its insertion point. The ` +
        `template's own CheckIfAppIsRunning sits BELOW the hook, so it cannot satisfy this rule ` +
        `by itself — that position is the defect.`
    );
  }
}

// ─── RULE 11 — the measuring mode is reachable by name ─────────────────────────────────────────
//
// WHY A RULE ABOUT WIRING EARNS ITS PLACE BESIDE RULES ABOUT BYTES. Rule 9 was written to be run
// «before handing anyone an installer» (see the banner at the top of this file). It then went four
// phases without a single invocation passing `--post-build`, because nothing asserted the
// invocation existed: not `.github/workflows/frontend.yml`, which runs `npm run nsis:check`; not
// `gui-pro/package.json`, whose script body carried no flag; not `prerelease`. A rule nothing calls
// reports nothing, and reports it in the same silence as a rule that found nothing wrong. Rule 11
// is the assertion that the door is still there, and it carries rule 9 back into reach in the same
// motion as rule 10.
//
// WHAT IT DOES NOT PROVE, stated here rather than left to be assumed: it does NOT prove anybody RAN
// the script. Nothing readable from a checkout can prove that. What runs it is
// `.github/workflows/installer-bundle.yml`, which builds the bundle on a Windows runner and then
// invokes this gate in its measuring mode, plus the build ritual in CLAUDE.md.
//
// It reads only git-tracked files and needs no build, so unlike rule 10 it runs everywhere this
// gate runs — the release branch included.
{
  const pkgPath = path.join(ROOT, path.dirname(DEFAULT_BUILT_APP), "package.json");
  const problems = [];
  let scripts = null;
  try {
    scripts = JSON.parse(fs.readFileSync(pkgPath, "utf8").replace(/^﻿/, "")).scripts || {};
  } catch (e) {
    problems.push(`${rel(pkgPath)} cannot be read or parsed: ${e.message}`);
  }
  if (scripts) {
    const gateFile = path.basename(__filename);
    const wired = Object.entries(scripts).filter(
      ([, bodyText]) => bodyText.includes(gateFile) && bodyText.includes("--post-build")
    );
    if (!wired.length) {
      problems.push(
        `no script in ${rel(pkgPath)} invokes ${gateFile} with --post-build. Rule 9 and rule 10 ` +
          `both have a measuring mode; with no named script asking for it, CI and \`prerelease\` ` +
          `can never reach it and the two rules go quiet without going red — which is how rule 9 ` +
          `spent four phases having never run. Restore \`nsis:check:post\`.`
      );
    }
  }
  rule(11, "a named npm script invokes this gate with the measuring flag", problems);
}

// ─── THE ERASURE ANALYSER (the machinery behind rules 12 and 13) ────────────────────────────────
//
// WHAT IT MEASURES. Four facts about the EMITTED uninstall section with the hook macros expanded
// at their insertion points — the composite the compiler actually walks, because the emitted
// script only `!include`s the hook file and inserts its macros by name, so neither file alone
// carries the answer. That is the same reason rule 10 lives in this gate rather than in Rust.
//
//   (1) THE HOOK'S EXPANSION POINT LIES OUTSIDE the template's own two-condition block. This is
//       the fact that makes the region's own guard load-bearing rather than decorative: the
//       template's `${If} $DeleteAppDataCheckboxState = 1 ${AndIf} $UpdateMode <> 1` block CLOSES
//       two lines above the hook insertion, so the hook body runs on EVERY uninstall and must
//       carry its own conditions. If a future template moved the insertion inside that block,
//       this rule says so out loud instead of silently becoming redundant.
//   (2) THE REGION'S MARKERS ARE PRESENT in the composite, and the two statements immediately
//       following the opening marker are the ticked condition and the not-updating condition,
//       CONJOINED. `lifecycle.rs` asserts that shape over the hook SOURCE; this asserts it over
//       the text the compiler was handed.
//   (3) BOTH VARIABLES THE REGION READS ARE DECLARED in the emitted script. A comparison against
//       a variable the script never declares is not a guard — NSIS does not warn, it just never
//       matches, and an erasure that never runs looks exactly like an erasure that ran cleanly.
//   (4) THE TWO PATHS THAT MUST DELETE NOTHING:
//       (4a) UPDATE. Every removal in the composite that can reach a place holding the user's own
//            files must sit inside a block conditioned on this not being an update. The
//            conditions are found by WALKING THE CONDITIONAL NESTING, not by matching text near
//            the line: an `${Else}` arm does not inherit its `${If}`'s condition, and a condition
//            joined by `${OrIf}` is not a guard at all.
//       (4b) REINSTALL. The arm taken when the maintenance page is answered with the components
//            choice reaches no uninstaller invocation — it replaces files and invokes nothing.
//
// WHAT IS DELIBERATELY OUT OF SCOPE, stated rather than left to be inferred. (4a) walks FILESYSTEM
// removals only. The user's data is files; the registry removals in this section are install state
// — the programs-list entry, the installer's own product key, and autostart VALUES this product
// wrote into the user's Run key. An autostart value pointing at an executable that has just been
// deleted is not the user's data, it is a broken registration left by us, and the hook says so at
// length. Widening (4a) to the registry would fail this gate on correct code, and a rule that must
// be suppressed to stay green stops being read.
//
// NO RULE HERE MAY PASS OVER A FILE IT DID NOT OPEN — hence rule 13's availability triage, and
// hence rule 12, which proves on every single invocation that the analyser still rejects the
// things it exists to reject. Six checks in this phase turned out to be incapable of failing.

const NSIS_REMOVALS = new Set(["delete", "rmdir"]);
const NSIS_EXECUTIONS = new Set([
  "exec",
  "execwait",
  "execshell",
  "nsexec::exec",
  "nsexec::exectolog",
  "nsexec::exectostack",
]);
// Roots that resolve inside a person's own profile and hold things that person owns. A removal
// under one of these during an update is data loss with a progress bar — which is what this
// product actually shipped, for years, before phase 30.1.
const USER_DATA_ROOTS = new Set([
  "$APPDATA", "$LOCALAPPDATA", "$PROFILE", "$DOCUMENTS", "$PERSONAL", "$DESKTOP",
  "$SMPROGRAMS", "$STARTMENU", "$STARTUP", "$QUICKLAUNCH", "$MUSIC", "$PICTURES",
  "$VIDEOS", "$FAVORITES", "$RECENT", "$SENDTO", "$TEMPLATES",
]);
// Roots holding what the INSTALLER itself put there: its own program folder and scratch space.
// $INSTDIR is exempt for a NON-RECURSIVE removal only — see the D-05 clause in classifyRemoval.
const INSTALL_SCRATCH_ROOTS = new Set(["$INSTDIR", "$TEMP", "$PLUGINSDIR", "$EXEDIR", "$OUTDIR"]);

const ERASE_REGION_BEGIN = /BEGIN REGION TT_ERASE_DATA_ROOT/;
const ERASE_REGION_END = /END REGION TT_ERASE_DATA_ROOT/;
const ERASE_COND_TICKED = /^\$\{If\}\s+\$DeleteAppDataCheckboxState\s*=\s*1$/;
const ERASE_COND_NOT_UPDATING = /^\$\{AndIf\}\s+\$UpdateMode\s*(<>|!=)\s*1$/;
const NOT_UPDATING = /^\$UpdateMode\s*(<>|!=)\s*1$/;

/** `!define NAME value` from any number of scripts, first definition wins (as NSIS does). */
function nsisDefines(...texts) {
  const defs = new Map();
  for (const t of texts) {
    if (!t) continue;
    for (const line of t.split(/\r?\n/)) {
      const m = /^\s*!define\s+([A-Za-z_][A-Za-z0-9_.]*)\s+(.+?)\s*$/.exec(line);
      if (!m) continue;
      const q = /^"([^"]*)"$/.exec(m[2]);
      if (!defs.has(m[1])) defs.set(m[1], q ? q[1] : m[2]);
    }
  }
  return defs;
}
/** Expand `${NAME}` until it stops changing. Unknown names are left alone, never guessed. */
function expandDefines(s, defs) {
  let out = s;
  for (let i = 0; i < 6; i++) {
    const next = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g, (all, n) => (defs.has(n) ? defs.get(n) : all));
    if (next === out) break;
    out = next;
  }
  return out;
}
/**
 * "" for a blank or comment-only line, the trimmed STATEMENT otherwise — with any trailing comment
 * removed.
 *
 * The trailing comment is not cosmetic here. The template writes its conditions as
 * `${If} $R0 = 0 ; Same version, proceed`, and a condition compared with the comment still
 * attached matches nothing: the first draft of this analyser silently failed to find the arm it
 * exists to check, and reported the absence as a violation of the template rather than of itself.
 * Quotes are respected so a `;` inside a string is not mistaken for a comment, and NSIS's `$\"`
 * escape is skipped so an escaped quote does not flip the quoting state.
 */
const codeOf = (line) => {
  const t = line.trim();
  if (!t || t.startsWith(";") || t.startsWith("#")) return "";
  let quote = null;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quote) {
      if (ch === quote && !(i >= 2 && t[i - 2] === "$" && t[i - 1] === "\\")) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      if (!(i >= 2 && t[i - 2] === "$" && t[i - 1] === "\\")) quote = ch;
      continue;
    }
    if (ch === ";" || ch === "#") return t.slice(0, i).trim();
  }
  return t;
};
/** The lines of one `!macro NAME` body, with their real line numbers in the hook file. */
function macroBody(hookLines, name, hookFile) {
  const at = hookLines.findIndex((l) => l.trim() === `!macro ${name}`);
  if (at < 0) return null;
  let end = at + 1;
  while (end < hookLines.length && hookLines[end].trim() !== "!macroend") end++;
  return hookLines.slice(at + 1, end).map((text, i) => ({ text, line: at + 2 + i, file: hookFile }));
}
/**
 * One region of the emitted script — a Section or a Function — with the named macros REPLACED BY
 * THEIR BODIES at their insertion points. Every entry keeps the file and line it came from, so a
 * violation can be printed against the file a person can actually open.
 */
function compositeRegion(genLines, genFile, hookLines, hookFile, startRe, macroNames) {
  const start = genLines.findIndex((l) => startRe.test(l));
  if (start < 0) return { missingRegion: String(startRe) };
  let end = start + 1;
  while (end < genLines.length && !/^\s*(SectionEnd|FunctionEnd)\b/.test(genLines[end])) end++;
  const entries = [];
  // From the line AFTER the `Section`/`Function` header: the header is not a statement of the
  // region, and a caller asking «what does this region do first?» must not be handed its name.
  for (let i = start + 1; i <= Math.min(end, genLines.length - 1); i++) {
    const code = codeOf(genLines[i]);
    const ins = /^!insertmacro\s+(\S+)/.exec(code);
    if (ins && macroNames.includes(ins[1])) {
      const bodyLines = macroBody(hookLines, ins[1], hookFile);
      if (!bodyLines) return { missingMacro: ins[1] };
      entries.push({ text: genLines[i], line: i + 1, file: genFile, expands: ins[1] });
      entries.push(...bodyLines);
      continue;
    }
    entries.push({ text: genLines[i], line: i + 1, file: genFile });
  }
  return { entries };
}
/**
 * Walk LogicLib nesting and hand every ordinary statement the conditions actually in force.
 *
 * A frame carries the conditions of the CURRENT ARM and whether they are joined purely by
 * `${AndIf}`. Both matter: an `${Else}` arm runs under the NEGATION of its `${If}`, so it inherits
 * nothing, and `${If} A ${OrIf} B` runs when either holds, so neither A nor B guards anything.
 * Getting this wrong in the safe direction is the difference between a rule and a decoration.
 */
function walkConditions(entries, visit) {
  const problems = [];
  const stack = [];
  for (const e of entries) {
    const code = codeOf(e.text);
    if (!code) continue;
    const m = /^\$\{(\w+)\}\s*(.*)$/.exec(code);
    const kw = m ? m[1] : "";
    const rest = m ? m[2].trim() : "";
    const top = stack[stack.length - 1];
    switch (kw) {
      case "If": case "Unless": case "IfNot":
        stack.push({ conds: [rest], allAnd: true, at: e });
        continue;
      case "AndIf": case "AndUnless": case "AndIfNot":
        if (top) top.conds.push(rest);
        else problems.push(`${e.file}:${e.line} — \`${code}\` with no \`\${If}\` open above it.`);
        continue;
      case "OrIf": case "OrUnless": case "OrIfNot":
        if (top) { top.conds.push(rest); top.allAnd = false; }
        else problems.push(`${e.file}:${e.line} — \`${code}\` with no \`\${If}\` open above it.`);
        continue;
      case "ElseIf": case "ElseUnless":
        if (top) { top.conds = [rest]; top.allAnd = true; }
        continue;
      case "Else":
        if (top) { top.conds = []; top.allAnd = true; }
        continue;
      case "EndIf": case "EndUnless":
        if (stack.length) stack.pop();
        else problems.push(`${e.file}:${e.line} — \`\${EndIf}\` with nothing open above it.`);
        continue;
      case "Do": case "DoWhile": case "DoUntil": case "Select":
        stack.push({ conds: [], allAnd: true, at: e });
        continue;
      case "Loop": case "LoopWhile": case "LoopUntil": case "EndSelect":
        if (stack.length) stack.pop();
        continue;
      default:
        break;
    }
    visit(e, code, stack.slice());
  }
  if (stack.length) {
    const f = stack[stack.length - 1];
    problems.push(
      `${f.at.file}:${f.at.line} — \`\${If} ${f.conds.join(" ")}\` is never closed inside this ` +
        `region, so no statement below it can be attributed to a condition. Refusing to judge.`
    );
  }
  return problems;
}
/** The conditions in force spell «this is not an update», as a pure conjunction. */
const guardedAgainstUpdate = (stack) =>
  stack.some((f) => f.allAnd && f.conds.some((c) => NOT_UPDATING.test(c.trim())));
const describeConditions = (stack) => {
  const all = stack.flatMap((f) => f.conds);
  return all.length ? all.join(" AND ") : "NO CONDITION AT ALL";
};
const firstQuoted = (code) => {
  const m = /"([^"]*)"|'([^']*)'/.exec(code);
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
};
/** @returns {null|{head:string, recursive:boolean, raw:string|null}} */
function parseRemoval(code) {
  const head = code.split(/\s+/)[0].toLowerCase();
  if (!NSIS_REMOVALS.has(head)) return null;
  return { head, recursive: /\s\/r(\s|$)/i.test(code), raw: firstQuoted(code) };
}
/**
 * Where can this removal land? Fail-closed by construction: anything whose root this gate does not
 * KNOW is reported as unclassified rather than waved through, so a future `RMDir /r "$MUSIC\..."`
 * cannot pass merely because nobody thought to list $MUSIC.
 */
function classifyRemoval(rm, defs, tainted) {
  if (rm.raw === null) return { kind: "unclassified", why: "no quoted path argument" };
  const p = expandDefines(rm.raw, defs);
  const root = p.split("\\")[0].trim();
  const upper = root.toUpperCase();
  if (/^\$(R?\d)$/.test(root)) {
    // A register. It is user data if it was ever loaded from a file or the registry — see the
    // taint pass below.
    return tainted.has(root)
      ? { kind: "data", why: `${root} holds a path this uninstaller READ at run time` }
      : { kind: "unclassified", why: `${root} is a register this gate cannot resolve` };
  }
  if (USER_DATA_ROOTS.has(upper)) return { kind: "data", why: `${root} is a per-user root` };
  if (INSTALL_SCRATCH_ROOTS.has(upper)) {
    // D-05: on every machine installed before phase 32 the install directory IS the data root, so
    // a RECURSIVE sweep of it is a user-data removal however it is spelled.
    if (upper === "$INSTDIR" && rm.recursive && p.trim() === root) {
      return { kind: "data", why: `a RECURSIVE sweep of $INSTDIR, which on pre-32 machines IS the data root (D-05)` };
    }
    return { kind: "exempt", why: `${root} holds what the installer itself put there` };
  }
  return { kind: "unclassified", why: `«${p}» starts with «${root}», which this gate does not classify` };
}

/**
 * The whole analysis, as a pure function of two texts — which is what lets rule 12 run it against
 * fixtures carrying known violations on every invocation, with no build in sight.
 * @returns {{problems:string[], stats:{data:number, exempt:number}}}
 */
function analyseErasure(genText, hookText, genFile, hookFile) {
  const problems = [];
  const stats = { data: 0, exempt: 0 };
  const genLines = genText.split(/\r?\n/);
  const hookLines = hookText.split(/\r?\n/);
  const defs = nsisDefines(genText, hookText);

  // ── (3) both variables the region reads are DECLARED in the emitted script ──────────────────
  for (const v of ["UpdateMode", "DeleteAppDataCheckboxState"]) {
    const declared = genLines.some((l) => new RegExp(`^\\s*Var\\s+(/GLOBAL\\s+)?${v}\\s*$`).test(l));
    if (!declared) {
      problems.push(
        `${genFile} declares no \`Var ${v}\`, yet the erasure's guard compares against ` +
          `$${v}. NSIS does not warn about that: the comparison simply never matches, and an ` +
          `erasure that never runs is indistinguishable from one that ran and found nothing.`
      );
    }
  }

  // ── (1) the hook's expansion point lies OUTSIDE the template's own two-condition block ──────
  const rawUninstall = compositeRegion(genLines, genFile, hookLines, hookFile, /^Section\s+Uninstall\b/, []);
  if (rawUninstall.missingRegion) {
    problems.push(`${genFile} has no \`Section Uninstall\` — the subject of this rule is gone.`);
    return { problems, stats };
  }
  let sawTemplateGuard = false;
  let sawInsertion = false;
  problems.push(
    ...walkConditions(rawUninstall.entries, (e, code, stack) => {
      if (stack.some((f) => f.conds.some((c) => /\$DeleteAppDataCheckboxState/.test(c)))) sawTemplateGuard = true;
      if (!/^!insertmacro\s+NSIS_HOOK_POSTUNINSTALL\b/.test(code)) return;
      sawInsertion = true;
      if (stack.length) {
        problems.push(
          `${e.file}:${e.line} — the post-uninstall hook is expanded INSIDE a conditional ` +
            `(${describeConditions(stack)}). The region in the hook carries its own two ` +
            `conditions precisely because the template's block closes above this point; nested ` +
            `here, that guard is either redundant or doubled, and neither is what the hook says ` +
            `it is. Say so rather than let the file lie about why it is safe.`
        );
      }
    })
  );
  if (!sawInsertion) {
    problems.push(
      `${genFile}'s \`Section Uninstall\` never inserts NSIS_HOOK_POSTUNINSTALL, so the region ` +
        `this rule is about does not run there at all.`
    );
  }
  if (!sawTemplateGuard) {
    problems.push(
      `${genFile}'s \`Section Uninstall\` contains no block conditioned on ` +
        `$DeleteAppDataCheckboxState — the template's own erasure is gone, and with it the ` +
        `reason the hook's insertion point is outside anything.`
    );
  }

  // ── the composite the compiler walks: the section with both hook macros expanded ────────────
  const composite = compositeRegion(genLines, genFile, hookLines, hookFile, /^Section\s+Uninstall\b/, [
    "NSIS_HOOK_PREUNINSTALL",
    "NSIS_HOOK_POSTUNINSTALL",
  ]);
  if (composite.missingMacro) {
    problems.push(`${hookFile} defines no \`!macro ${composite.missingMacro}\` to expand.`);
    return { problems, stats };
  }

  // ── (2) the region's markers, and its first two statements ──────────────────────────────────
  const beginAt = composite.entries.findIndex((e) => ERASE_REGION_BEGIN.test(e.text));
  const endAt = composite.entries.findIndex((e) => ERASE_REGION_END.test(e.text));
  if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
    problems.push(
      `the composite carries no complete TT_ERASE_DATA_ROOT region (begin ${beginAt < 0 ? "absent" : "present"}, ` +
        `end ${endAt < 0 ? "absent" : "present"}). The region's markers are how this rule finds ` +
        `the two conditions; without them nothing here is measuring the erasure.`
    );
  } else {
    const after = composite.entries.slice(beginAt + 1).filter((e) => codeOf(e.text) && !codeOf(e.text).startsWith("!"));
    const [one, two] = after;
    const oneCode = one ? codeOf(one.text) : "";
    const twoCode = two ? codeOf(two.text) : "";
    if (!ERASE_COND_TICKED.test(oneCode) || !ERASE_COND_NOT_UPDATING.test(twoCode)) {
      problems.push(
        `${one ? `${one.file}:${one.line}` : hookFile} — the two statements immediately after the ` +
          `TT_ERASE_DATA_ROOT marker are «${oneCode || "(nothing)"}» and «${twoCode || "(nothing)"}», ` +
          `not the ticked condition followed by the not-updating condition conjoined. Anything ` +
          `between them, or an \${OrIf} in place of the \${AndIf}, is the difference between a ` +
          `branch a person opted into and a sweep that runs during an update.`
      );
    }
  }

  // ── (4a) every removal that can reach the user's own files is guarded against an update ─────
  const tainted = new Set();
  let dataRemovals = 0;
  problems.push(
    ...walkConditions(composite.entries, (e, code, stack) => {
      // Taint is MONOTONE on purpose: a register loaded from a file or the registry holds a path
      // nobody in this script chose, and a later literal assignment inside one arm must not
      // "clean" it — that would make the verdict depend on a branch this walker does not evaluate.
      const read = /^(FileRead|ReadRegStr|ReadRegExpandStr|ReadINIStr|ReadEnvStr)\s+(\$\w+)\s+(\$\w+)?/i.exec(code);
      if (read) tainted.add(/^FileRead$/i.test(read[1]) ? read[3] || read[2] : read[2]);
      const copy = /^StrCpy\s+(\$\w+)\s+(\$\w+)/i.exec(code);
      if (copy && tainted.has(copy[2])) tainted.add(copy[1]);

      // A removal written as a one-liner conditional cannot be attributed to its condition by a
      // walker that only tracks blocks. Refused rather than mis-attributed in either direction.
      if (/^\$\{IfThen\}/.test(code) && /\$\{\|\}\s*(Delete|RMDir)\b/i.test(code)) {
        problems.push(
          `${e.file}:${e.line} — a removal written inside \`\${IfThen}\` cannot be attributed to ` +
            `its condition by this walker. Write it as an \`\${If}\` block so the guard is visible.`
        );
        return;
      }
      const rm = parseRemoval(code);
      if (!rm) return;
      const cls = classifyRemoval(rm, defs, tainted);
      if (cls.kind === "exempt") { stats.exempt++; return; }
      if (cls.kind === "unclassified") {
        problems.push(
          `${e.file}:${e.line} — \`${code}\` removes something this gate cannot place ` +
            `(${cls.why}). An unplaceable removal in the uninstall section is refused rather ` +
            `than assumed harmless: classify the root here, or spell the path so it can be.`
        );
        return;
      }
      stats.data++;
      dataRemovals++;
      if (!guardedAgainstUpdate(stack)) {
        problems.push(
          `${e.file}:${e.line} — \`${code}\` can reach the user's own files (${cls.why}) and the ` +
            `conditions in force there are: ${describeConditions(stack)}. Nothing in them says ` +
            `«this is not an update». An UPDATE RUNS THIS UNINSTALLER, so this line deletes a ` +
            `live user's servers, saved SSH passwords and routing rules during what they ` +
            `experience as maintenance — which this product actually did, for years, before ` +
            `phase 30.1.`
        );
      }
    })
  );
  if (dataRemovals === 0) {
    problems.push(
      `the composite contains no removal that can reach the user's own files at all, so there is ` +
        `nothing here whose guard could be judged. Either the erasure is gone or this rule has ` +
        `stopped seeing it; both are reported rather than passed.`
    );
  }

  // ── (4b) the reinstall path replaces files and invokes nothing ──────────────────────────────
  problems.push(...analyseReinstallPath(genLines, genFile, hookLines, hookFile));
  return { problems, stats };
}

/**
 * THE SECOND PATH THAT MUST DELETE NOTHING. Choosing «Переустановить компоненты» on the
 * maintenance page must not start the uninstaller — if it did, the uninstall section above would
 * run, and everything (4a) proves would be the only thing standing between a maintenance click
 * and the user's data. The chain asserted here is: the first radio's CAPTION on a same-version
 * install is the components caption, that radio's handle is the one whose state is read into the
 * variable the leave function branches on, the arm for that choice jumps to `reinst_done`, and
 * `reinst_done` sits BELOW the block that invokes the uninstaller — so the jump skips it. Then,
 * separately, the Install section with its hooks expanded invokes no uninstaller of its own.
 */
function analyseReinstallPath(genLines, genFile, hookLines, hookFile) {
  const problems = [];
  const leave = compositeRegion(genLines, genFile, hookLines, hookFile, /^Function\s+PageLeaveReinstall\b/, []);
  const page = compositeRegion(genLines, genFile, hookLines, hookFile, /^Function\s+PageReinstall\b/, []);
  if (leave.missingRegion || page.missingRegion) {
    problems.push(
      `${genFile} has no \`Function PageLeaveReinstall\`/\`Function PageReinstall\` — the ` +
        `maintenance page this assertion is about is gone, so the reinstall path cannot be judged.`
    );
    return problems;
  }

  const idxOf = (entries, re) => entries.findIndex((e) => re.test(codeOf(e.text)));
  const unAt = idxOf(leave.entries, /^reinst_uninstall:$/);
  const doneAt = idxOf(leave.entries, /^reinst_done:$/);
  if (unAt < 0 || doneAt < 0) {
    problems.push(
      `PageLeaveReinstall carries no reinst_uninstall:/reinst_done: pair (uninstall ` +
        `${unAt < 0 ? "absent" : "present"}, done ${doneAt < 0 ? "absent" : "present"}), so a ` +
        `jump past the uninstaller cannot be shown to be a jump past anything.`
    );
    return problems;
  }
  if (doneAt < unAt) {
    problems.push(
      `PageLeaveReinstall places reinst_done: ABOVE reinst_uninstall:, so jumping to it no ` +
        `longer skips the uninstaller invocation — it falls into it.`
    );
  }
  leave.entries.forEach((e, i) => {
    const code = codeOf(e.text);
    if (!code) return;
    if (!NSIS_EXECUTIONS.has(code.split(/\s+/)[0].toLowerCase())) return;
    if (i > unAt && i < doneAt) return;
    problems.push(
      `${e.file}:${e.line} — \`${code}\` runs a program in PageLeaveReinstall OUTSIDE the ` +
        `reinst_uninstall: block. Every invocation must live in the arm the components choice ` +
        `jumps over, or that jump stops meaning «invokes nothing».`
    );
  });

  let updateArm = false;
  let componentsArm = false;
  let componentsUninstalls = false;
  problems.push(
    ...walkConditions(leave.entries, (e, code, stack) => {
      const under = (re) => stack.some((f) => f.allAnd && f.conds.some((c) => re.test(c.trim())));
      if (/^Goto\s+reinst_done$/.test(code) && under(/^\$UpdateMode\s*=\s*1$/)) updateArm = true;
      const sameVersionFirstChoice = under(/^\$R0\s*=\s*0$/) && under(/^\$R1\s*=\s*1$/);
      if (sameVersionFirstChoice && /^Goto\s+reinst_done$/.test(code)) componentsArm = true;
      if (sameVersionFirstChoice && /^Goto\s+reinst_uninstall$/.test(code)) componentsUninstalls = true;
    })
  );
  if (!updateArm) {
    problems.push(
      `PageLeaveReinstall has no arm that, when $UpdateMode = 1, goes straight to reinst_done. ` +
        `An update would then be routed through the uninstaller by the page itself.`
    );
  }
  if (!componentsArm || componentsUninstalls) {
    problems.push(
      `PageLeaveReinstall's same-version first-choice arm ` +
        `(${componentsArm ? "reaches reinst_done" : "reaches NO reinst_done"}` +
        `${componentsUninstalls ? " but ALSO reaches reinst_uninstall" : ""}) does not skip the ` +
        `uninstaller. That arm is «Переустановить компоненты»: it must replace files and invoke ` +
        `nothing, or a reinstall silently becomes an uninstall-then-install over the user's data.`
    );
  }

  // The caption tie: without it, "$R1 = 1" is a number nobody has connected to what the person
  // actually clicked.
  const state = leave.entries.map((e) => codeOf(e.text)).find(Boolean);
  if (!/^\$\{NSD_GetState\}\s+\$R2\s+\$R1$/.test(state || "")) {
    problems.push(
      `PageLeaveReinstall does not begin by reading the FIRST radio's state into the variable ` +
        `its arms branch on (found «${state || "nothing"}»), so the arm above cannot be tied to ` +
        `the button the person clicked.`
    );
  }
  let captionTied = false;
  walkConditions(page.entries, (e, code, stack) => {
    if (!stack.some((f) => f.allAnd && f.conds.some((c) => /^\$R0\s*=\s*0$/.test(c.trim())))) return;
    if (/^StrCpy\s+\$R2\s+"\$\(addOrReinstall\)"$/.test(code)) captionTied = true;
  });
  const firstRadio = page.entries.map((e) => codeOf(e.text)).find((c) => /^\$\{NSD_CreateRadioButton\}/.test(c));
  if (!captionTied || !/\$R2\s*$/.test(firstRadio || "")) {
    problems.push(
      `PageReinstall no longer gives the FIRST radio button the components caption on a ` +
        `same-version install (caption ${captionTied ? "found" : "NOT found"}, first radio ` +
        `«${firstRadio || "absent"}»). The reinstall assertion above reads a radio INDEX; this ` +
        `is what ties that index to «Переустановить компоненты» rather than to whatever the ` +
        `template happens to put first.`
    );
  }

  // The Install section itself must invoke no uninstaller — the components choice lands here.
  const install = compositeRegion(genLines, genFile, hookLines, hookFile, /^Section\s+Install\b/, [
    "NSIS_HOOK_PREINSTALL",
    "NSIS_HOOK_POSTINSTALL",
  ]);
  if (install.missingRegion) {
    problems.push(`${genFile} has no \`Section Install\` — the arm the components choice takes is gone.`);
    return problems;
  }
  if (install.missingMacro) {
    problems.push(`${hookFile} defines no \`!macro ${install.missingMacro}\` to expand.`);
    return problems;
  }
  for (const e of install.entries) {
    const code = codeOf(e.text);
    if (!code) continue;
    const head = code.split(/\s+/)[0].toLowerCase();
    const invokes = NSIS_EXECUTIONS.has(head) && /uninstall/i.test(code);
    // READING the previous install's UninstallString is how a section would find an uninstaller to
    // run; WRITING it is how this section registers its own, which is the install doing its job.
    // The first draft flagged the write and would have failed the gate on correct code.
    const reads = /^Read(RegStr|RegExpandStr)\b/i.test(code) && /"UninstallString"/i.test(code);
    if (invokes || reads) {
      problems.push(
        `${e.file}:${e.line} — \`${code}\` ${invokes ? "invokes an uninstaller" : "reads the UninstallString"} ` +
          `inside the Install section. The components choice runs this section: it must replace ` +
          `files and invoke nothing.`
      );
    }
  }
  return problems;
}

// ─── RULE 12 — the erasure analyser rejects what it must ────────────────────────────────────────
//
// FIXTURES, NOT FAITH — the same principle as rule 0, for the same reason and after the same kind
// of accident. This phase produced seven checks that could not fail; each was green from the day
// it was written. So rule 13's analyser is run here, on EVERY invocation and with no build in
// sight, against a miniature emitted script and hook that carry the shape of the real ones, plus
// six MUTANTS of that pair. Each mutant is produced by a textual substitution whose landing is
// verified (a substitution that silently matched nothing would make the mutant identical to the
// clean fixture, and «the clean fixture passed» would then be reported as «the mutant was
// rejected»), and each must be rejected FOR ITS OWN REASON, matched against its own pattern.
const FIXTURE_GEN = `; a miniature of the emitted script, carrying only what rules 12 and 13 read.
!define PRODUCTNAME "Fixture App"
!define BUNDLEID "com.fixture.app"
!define UNINSTKEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${PRODUCTNAME}"
Var UpdateMode
Var DeleteAppDataCheckboxState

Function PageReinstall
  \${If} $R0 = 0
    StrCpy $R2 "$(addOrReinstall)"
    StrCpy $R3 "$(uninstallApp)"
  \${ElseIf} $R0 = 1
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    StrCpy $R3 "$(dontUninstall)"
  \${EndIf}
  \${NSD_CreateRadioButton} 30u 50u -30u 8u $R2
  \${NSD_CreateRadioButton} 30u 70u -30u 8u $R3
FunctionEnd

Function PageLeaveReinstall
  \${NSD_GetState} $R2 $R1
  \${If} $UpdateMode = 1
    Goto reinst_done
  \${EndIf}
  \${If} $R0 = 0
    \${If} $R1 = 1
      Goto reinst_done
    \${Else}
      Goto reinst_uninstall
    \${EndIf}
  \${EndIf}
  reinst_uninstall:
    ReadRegStr $R1 SHCTX "\${UNINSTKEY}" "UninstallString"
    ExecWait '$R1' $0
  reinst_done:
FunctionEnd

Section Install
  SetOutPath $INSTDIR
  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif
  File "app.exe"
SectionEnd

Section Uninstall
  !insertmacro CheckIfAppIsRunning "app.exe" "\${PRODUCTNAME}"
  Delete "$INSTDIR\\app.exe"
  RMDir "$INSTDIR"
  \${If} $UpdateMode <> 1
    Delete "$DESKTOP\\\${PRODUCTNAME}.lnk"
  \${EndIf}
  \${If} $DeleteAppDataCheckboxState = 1
  \${AndIf} $UpdateMode <> 1
    RmDir /r "$APPDATA\\\${BUNDLEID}"
  \${EndIf}
  !ifmacrodef NSIS_HOOK_POSTUNINSTALL
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  !endif
SectionEnd
`;
const FIXTURE_HOOK = `!define TT_INSTALL_DIR "$INSTDIR"
!define TT_DATA_ROOT_RECORD "\${TT_INSTALL_DIR}\\.data-root.txt"

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "installing"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "\${TT_DATA_ROOT_RECORD}"
  ; BEGIN REGION TT_ERASE_DATA_ROOT
  \${If} $DeleteAppDataCheckboxState = 1
  \${AndIf} $UpdateMode <> 1
    FileRead $R5 $R8
    RMDir /r "$R8"
  \${EndIf}
  ; END REGION TT_ERASE_DATA_ROOT
  Delete "$TEMP\\fixture_setup.exe"
  RMDir "$INSTDIR"
!macroend
`;
{
  const problems = [];
  const clean = analyseErasure(FIXTURE_GEN, FIXTURE_HOOK, "fixture.nsi", "fixture.nsh");
  if (clean.problems.length) {
    problems.push(
      `the CLEAN fixture was rejected, so every rejection below proves nothing about the ` +
        `analyser: ${clean.problems.join(" | ")}`
    );
  }
  const mutants = [
    {
      what: "the hook expansion moved INSIDE the template's two-condition block",
      gen: [
        `    RmDir /r "$APPDATA\\\${BUNDLEID}"\n  \${EndIf}\n  !ifmacrodef NSIS_HOOK_POSTUNINSTALL\n    !insertmacro NSIS_HOOK_POSTUNINSTALL\n  !endif`,
        `    RmDir /r "$APPDATA\\\${BUNDLEID}"\n    !insertmacro NSIS_HOOK_POSTUNINSTALL\n  \${EndIf}`,
      ],
      expect: /expanded INSIDE a conditional/,
    },
    {
      what: "a statement wedged between the region marker and its two conditions",
      hook: [`  \${If} $DeleteAppDataCheckboxState = 1`, `  DetailPrint "about to erase"\n  \${If} $DeleteAppDataCheckboxState = 1`],
      expect: /two statements immediately after the TT_ERASE_DATA_ROOT marker/,
    },
    {
      what: "the guard's variable is never declared in the emitted script",
      gen: [`Var UpdateMode\n`, ``],
      expect: /declares no `Var UpdateMode`/,
    },
    {
      what: "the data-root removal moved out of the guarded region",
      hook: [
        `    RMDir /r "$R8"\n  \${EndIf}\n  ; END REGION TT_ERASE_DATA_ROOT`,
        `  \${EndIf}\n  ; END REGION TT_ERASE_DATA_ROOT\n  RMDir /r "$R8"`,
      ],
      expect: /can reach the user's own files .* conditions in force there are: NO CONDITION AT ALL/s,
    },
    {
      what: "the components choice routed into the uninstaller",
      gen: [`    \${If} $R1 = 1\n      Goto reinst_done`, `    \${If} $R1 = 1\n      Goto reinst_uninstall`],
      expect: /same-version first-choice arm/,
    },
    {
      what: "a removal under a root this gate does not classify",
      hook: [`  Delete "$TEMP\\fixture_setup.exe"`, `  Delete "$MYSTERYROOT\\fixture_setup.exe"`],
      expect: /removes something this gate cannot place/,
    },
  ];
  for (const m of mutants) {
    let gen = FIXTURE_GEN;
    let hook = FIXTURE_HOOK;
    if (m.gen) gen = gen.replace(m.gen[0], m.gen[1]);
    if (m.hook) hook = hook.replace(m.hook[0], m.hook[1]);
    if (gen === FIXTURE_GEN && hook === FIXTURE_HOOK) {
      problems.push(
        `the mutation «${m.what}» DID NOT LAND — its substitution matched nothing, so the ` +
          `"rejection" below would only be the clean fixture passing. A mutation test whose ` +
          `mutant equals the original is the purest form of the vacuum this gate refuses.`
      );
      continue;
    }
    const got = analyseErasure(gen, hook, "fixture.nsi", "fixture.nsh").problems;
    if (!got.some((p) => m.expect.test(p))) {
      problems.push(
        `the analyser did not reject «${m.what}» for its own reason. It reported: ` +
          `${got.length ? got.join(" | ") : "NOTHING AT ALL"}.`
      );
    }
  }
  rule(
    12,
    "the erasure analyser rejects a moved hook, a broken guard, an undeclared variable, an unguarded removal, a reinstall that uninstalls, and a path it cannot place",
    problems,
    `1 clean fixture accepted, ${mutants.length} mutants each rejected for its own reason, with ` +
      `every mutation confirmed to have landed. This runs on every invocation and needs no build.`
  );
}

// ─── RULE 13 — the guard, and the two paths that must delete nothing, over the EMITTED script ───
//
// Availability is decided by the ARTIFACT and not by the flag, for the reason rule 10 states at
// length: a rule wired to `--post-build` alone prints nothing in every mode anyone actually uses.
{
  const ERASURE_APPS = POST_BUILD ? BUILT_APPS : [DEFAULT_BUILT_APP];
  const problems = [];
  let measured = 0;
  let totals = { data: 0, exempt: 0 };

  for (const relApp of ERASURE_APPS) {
    const app = path.join(ROOT, relApp);
    if (!APPS.includes(app)) {
      problems.push(`rule 13 names ${relApp}, which has no tauri.conf.json`);
      continue;
    }
    const hooks = subjects.find((s) => s.app === app && s.role === "hooks");
    if (!hooks) {
      problems.push(
        `${rel(app)}/tauri.conf.json configures no nsis.installerHooks, so there is no erasure ` +
          `region whose guard could be judged.`
      );
      continue;
    }
    const subject = emittedScriptSubject({
      ruleId: 13,
      app,
      hooks,
      cannotRead: "the guard over the emitted uninstall section",
      staleClause: "its guard is not this tree's guard",
      problems,
    });
    if (subject.state !== "ready") continue;

    const out = analyseErasure(
      subject.genText,
      subject.hookText,
      rel(subject.gen),
      rel(subject.includedHook)
    );
    problems.push(...out.problems);
    totals = { data: totals.data + out.stats.data, exempt: totals.exempt + out.stats.exempt };
    measured++;
  }

  if (measured > 0 || problems.length) {
    rule(
      13,
      "the emitted uninstall section guards the erasure, and the update and reinstall paths delete nothing",
      problems,
      `${measured} emitted script(s) measured, both uninstall hook macros expanded at their ` +
        `insertion points. ${totals.data} removal(s) that can reach the user's own files, each ` +
        `inside a block conditioned on this not being an update; ${totals.exempt} removal(s) of ` +
        `the installer's own files and scratch. Rule 12 proves this analyser still rejects.`
    );
  }
}

// ─── report ────────────────────────────────────────────────────────────────────
console.log(`== nsis-text-gate ${POST_BUILD ? "(source + build artifact)" : "(source)"} ==`);
for (const r of results) {
  if (r.warn) {
    console.log(`WARN  ${r.warn}`);
    continue;
  }
  console.log(`${r.bad.length ? "FAIL" : "PASS"}  rule ${r.id}  ${r.title}`);
  for (const p of r.bad) console.log(`        ${p}`);
  if (r.note && !r.bad.length) console.log(`        (${r.note})`);
}
const total = results.filter((r) => !r.warn).length;
console.log("");
console.log(`  apps      : ${APPS.map(rel).join(", ")}`);
console.log(`  files     : ${subjects.length}`);
console.log(`  rules     : ${total - failures}/${total} passed, ${warnings} warning(s)`);
if (failures) {
  console.log("RESULT: FAIL");
  process.exit(1);
}
console.log("RESULT: PASS");
process.exit(0);

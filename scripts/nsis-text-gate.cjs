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
 *   default      — source files only. Runs anywhere, needs no build artifact.
 *   --post-build — additionally asserts what the bundler actually emitted. Hard-fails when the
 *                  artifact is absent, so it can never be a silent no-op. Run it after
 *                  `npx tauri build --bundles nsis`, before handing anyone an installer.
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
const BUILT_APPS = postBuildArgs
  .map((a) => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : "gui-pro/src-tauri"))
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
    )
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
    )
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
// it by ABSOLUTE SOURCE PATH, so nothing copies it and nothing adds a BOM to it. Today all
// 1213 of its non-ASCII bytes are inside `;` comments and every DetailPrint is ASCII English,
// so a decoding regression there is invisible. The day someone writes a Russian DetailPrint it
// becomes the first user-visible casualty — and it would also be untranslatable.
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

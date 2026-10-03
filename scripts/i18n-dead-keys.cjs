/*
 * i18n-dead-keys.cjs — the set math behind scripts/i18n-dead-keys.sh.
 *
 * Read that script's header first: it carries the whole rationale (why four rules,
 * why the Rust backend is part of the corpus, why rule 3 is deliberately blunt, and
 * why a DEAD verdict is a hand-audit prompt rather than a delete list). This file is
 * only the mechanism.
 *
 * Split out of the shell script rather than inlined as a heredoc so it can be read,
 * diffed and lint-reviewed like code. CommonJS (.cjs) because gui-pro/package.json
 * declares "type": "module" but this script lives outside that package and is run by
 * bare `node`, which resolves module type from the nearest package.json — the repo root
 * has none, so .cjs is the unambiguous extension.
 *
 * Invoked as: node scripts/i18n-dead-keys.cjs [repo-root]
 * The root defaults to this file's parent directory, so `npm run i18n:check` works from
 * gui-pro/ without caring what the caller's cwd is. Exits 1 when at least one locale key
 * is reachable by no rule.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = process.argv[2] || path.join(__dirname, "..");

// ─── ALLOW-LIST ────────────────────────────────────────────────────────────────
// Keys the four rules structurally cannot see. One entry per line, each with the
// reason it is invisible — an entry without a reason is indistinguishable from a key
// nobody could be bothered to delete, and that is how allow-lists rot into a second
// dead-key store.
//
// A trailing "*" makes the entry a subtree: "foo.bar.*" spares everything under
// "foo.bar.". Use the narrowest form that covers the reason.
//
const ALLOW_LIST = [
  // The config editor's field tooltips. schema-builder.ts builds every one of them as
  // `${tooltipKeyPrefix}.${pathKey}` (lines 98 and 192) — a template that OPENS with a
  // hole, so rule 3 has no literal head to key off. The four prefixes are passed in as
  // literals (buildAllSchemaTrees, lines ~231-252: ".vpn", ".hosts", ".rules",
  // ".credentials") and the suffix is the dotted path of a field in the SERVER's TOML,
  // which is only known once a server has been read. So the reachable set is "whatever
  // the server happens to expose" and no static rule can enumerate it. Sparing the whole
  // subtree is the only honest answer; the cost of getting it wrong is a config field
  // whose tooltip renders its own key name.
  "server.config.field_desc.*",
];

// ─── KEYS ──────────────────────────────────────────────────────────────────────
function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const q = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, q, out);
    else out.push(q);
  }
  return out;
}

const LOCALES = path.join(ROOT, "gui-pro/src/shared/i18n/locales");
const ruKeys = flatten(JSON.parse(fs.readFileSync(path.join(LOCALES, "ru.json"), "utf8")), "", []).sort();
const enKeys = flatten(JSON.parse(fs.readFileSync(path.join(LOCALES, "en.json"), "utf8")), "", []).sort();

// ─── CORPUS ────────────────────────────────────────────────────────────────────
// Build output and local tool caches. `.hex-skills` is the odd one out and the reason
// this list matters: it sits INSIDE gui-pro/src, is gitignored, and exists only on a
// developer's machine. Anything scannable it ever holds would count as a reference here
// and not in CI — the exact shape of "green locally, red on the branch" this gate is
// supposed to prevent, so it is excluded before it can happen rather than after.
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "target",
  "gen",
  "storybook-static",
  ".hex-skills",
]);

function collect(dir, matches, acc) {
  // Missing directories are tolerated rather than fatal: the release branch carries a
  // trimmed checkout (no .storybook), and a gate that cannot run there is a gate that
  // gets deleted.
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(p, matches, acc);
      continue;
    }
    if (matches(p)) acc.push(p);
  }
  return acc;
}

const LOCALES_SEGMENT = path.join("i18n", "locales");
const files = [];
collect(
  path.join(ROOT, "gui-pro/src"),
  (p) => /\.(ts|tsx|js|jsx|mdx)$/.test(p) && !p.includes(LOCALES_SEGMENT),
  files,
);
collect(path.join(ROOT, "gui-pro/src-tauri/src"), (p) => /\.rs$/.test(p), files);
collect(path.join(ROOT, "gui-pro/.storybook"), (p) => /\.(ts|tsx|js)$/.test(p), files);
for (const html of ["index.html", "tray-menu.html", "notification.html"]) {
  const p = path.join(ROOT, "gui-pro", html);
  if (fs.existsSync(p)) files.push(p);
}
const corpus = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");

// ─── RULE 3: DYNAMIC PREFIXES ──────────────────────────────────────────────────
// Every template literal whose head — the run of characters between the opening backtick
// and the first ${ — looks like the start of a key path. The live prefix is that head cut
// back to its last dot, so both shapes in the tree are handled:
//
//   `status.${variant}`                       -> prefix "status"
//   `server.security.fail2ban.presets.${id}_help` -> prefix "server.security.fail2ban.presets"
//   `routing.${block}Title`                   -> prefix "routing"
//
// Two filters keep this from swallowing the bundle. The head must contain a dot, which
// rules out `EOF_${uuid}` and every `${a}-${b}` id template; and the prefix must read as
// a lowercase dotted identifier, which rules out `preset-radio-${id}` (hyphen), `w-${n}`
// (no dot) and version strings. A head that starts with a hole (`${ns}.title`) is
// invisible to this rule by construction — that is what the allow-list is for.
const DYNAMIC_HEAD_RE = /`([A-Za-z0-9_.]*)\$\{/g;
const PREFIX_SHAPE_RE = /^[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;
const dynamicPrefixes = new Set();
for (const m of corpus.matchAll(DYNAMIC_HEAD_RE)) {
  const head = m[1];
  const lastDot = head.lastIndexOf(".");
  if (lastDot <= 0) continue;
  const prefix = head.slice(0, lastDot);
  if (PREFIX_SHAPE_RE.test(prefix)) dynamicPrefixes.add(prefix);
}

// ─── RULE 2: PLURAL SUFFIXES ───────────────────────────────────────────────────
// The CLDR categories i18next appends to a base key when `count` is interpolated.
const PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other"];

// ─── CLASSIFY ──────────────────────────────────────────────────────────────────
const allowExact = new Set(ALLOW_LIST.filter((e) => !e.endsWith("*")));
const allowSubtrees = ALLOW_LIST.filter((e) => e.endsWith("*")).map((e) => e.slice(0, -1));

const isLiteral = (key) => corpus.includes(key);

function dynamicPrefixOf(key) {
  for (const prefix of dynamicPrefixes) {
    if (key === prefix || key.startsWith(prefix + ".")) return prefix;
  }
  return null;
}

const isAllowed = (key) => allowExact.has(key) || allowSubtrees.some((p) => key.startsWith(p));

const byLiteral = [];
const byPlural = [];
const byDynamic = [];
const byAllow = [];
const dead = [];

for (const key of ruKeys) {
  if (isLiteral(key)) {
    byLiteral.push(key);
    continue;
  }

  let pluralBase = null;
  for (const suffix of PLURAL_SUFFIXES) {
    if (key.endsWith(suffix) && isLiteral(key.slice(0, -suffix.length))) {
      pluralBase = key.slice(0, -suffix.length);
      break;
    }
  }
  if (pluralBase) {
    byPlural.push([key, pluralBase]);
    continue;
  }

  const prefix = dynamicPrefixOf(key);
  if (prefix) {
    byDynamic.push([key, prefix]);
    continue;
  }

  if (isAllowed(key)) {
    byAllow.push(key);
    continue;
  }

  dead.push(key);
}

// ─── REPORT ────────────────────────────────────────────────────────────────────
// The banner lives here, not in the shell wrapper, so the sh entry point and the npm
// entry point cannot drift into printing different things.
const pad = (n) => String(n).padStart(4);

console.log("== i18n-dead-keys: T-42 ==");
console.log("");
console.log("-- keys reached by NO rule (DEAD — fails this gate) --");
if (dead.length) for (const k of dead) console.log(`  DEAD KEY: ${k}`);
else console.log("  none");

console.log("");
console.log("-- spared by rule 3 (dynamic prefix) — a hand-audit queue, NOT a clean bill --");
if (byDynamic.length) {
  const grouped = new Map();
  for (const [k, p] of byDynamic) {
    if (!grouped.has(p)) grouped.set(p, []);
    grouped.get(p).push(k);
  }
  for (const [p, keys] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  \`${p}.\${...}\` spares ${keys.length}:`);
    for (const k of keys) console.log(`      ${k}`);
  }
} else {
  console.log("  none");
}

console.log("");
console.log("-- spared by rule 2 (plural sibling of a referenced base) --");
if (byPlural.length) for (const [k, base] of byPlural) console.log(`  ${k}  <- ${base}`);
else console.log("  none");

console.log("");
console.log("-- spared by rule 4 (allow-list) --");
if (byAllow.length) for (const k of byAllow) console.log(`  ${k}`);
else console.log("  none");

console.log("");
console.log("-- summary --");
console.log(`  locale leaf keys ru / en  : ${ruKeys.length} / ${enKeys.length}`);
console.log(`  corpus files scanned      : ${files.length}`);
console.log(`  dynamic prefixes detected : ${dynamicPrefixes.size}`);
console.log(`${pad(byLiteral.length)}  reached: literal reference (rule 1)`);
console.log(`${pad(byPlural.length)}  reached: plural sibling    (rule 2)`);
console.log(`${pad(byDynamic.length)}  reached: dynamic prefix   (rule 3)`);
console.log(`${pad(byAllow.length)}  reached: allow-list        (rule 4)`);
console.log(`${pad(dead.length)}  DEAD`);

if (dead.length) {
  console.log(
    "RESULT: FAIL (locale keys nothing in the tree can reach — delete each from BOTH bundles, or allow-list it with a reason)",
  );
  process.exit(1);
}
console.log("RESULT: PASS");

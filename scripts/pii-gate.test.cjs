/*
 * pii-gate.test.cjs — proof that the PII gate both catches and stays quiet.
 *
 * WHY BOTH HALVES MATTER EQUALLY
 *   A leak detector has two ways to fail and only one of them is loud. It can miss a real
 *   hostname — that is the failure everyone designs for. Or it can flag `rect.top` as a domain
 *   and `128x128@2x.png` as an e-mail, which is the failure that actually kills gates: the
 *   pre-gate scan produced 195 findings of which about a dozen were real, and a gate with that
 *   signal-to-noise ratio is switched off within a week. So this file carries a NOISE CORPUS of
 *   the exact strings that fooled the manual scan, and asserts zero findings on it. If a future
 *   tightening of the matchers starts flagging them again, this file goes red before the noise
 *   reaches anyone.
 *
 *   The mirror-image defect is a matcher quietly broken into always-false — a gate that reports
 *   all-clear because it stopped looking. Every class therefore has a positive arm with a real
 *   leak shape, and `scanTree` is exercised against a synthesised dirty tree AND a synthesised
 *   clean one, so neither "always finds" nor "never finds" can pass.
 *
 * EVERY FIXTURE HERE IS SYNTHETIC, AND TEST 34 IS WHY THAT IS TRUE RATHER THAN INTENDED
 *   This file's positive arms must contain leak shapes, so `pii-gate.cjs` puts its basename in
 *   SKIP_BASENAMES and never scans it. That skip is a blind spot on a file that travels to the
 *   public branch, so test 34 covers it from the inside: it scans this file's own source and fails
 *   on any value not declared in SYNTHETIC_FIXTURES.
 *
 * Invoked as: node scripts/pii-gate.test.cjs   (or `npm run pii:test` from gui-pro/)
 * Exit: 0 all tests pass, 1 at least one FAIL.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { scanText, scanTree, parseBaseline, applyBaseline, formatBaseline } = require("./pii-gate.cjs");

// ─── tiny runner (same shape as sign-windows-artifact.test.cjs) ─────────────────
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

/** findings of one class, by value, for terse assertions */
const values = (findings, cls) => findings.filter((f) => !cls || f.cls === cls).map((f) => f.value);
const hit = (text, file = "gui-pro/src-tauri/src/demo.rs") => scanText(text, file);

// ═══ 1. account name / absolute user paths ═════════════════════════════════════

test("1. catches a personal account name in a Windows path", () => {
  const f = hit(String.raw`    let p = r"geosite:C:\Users\mvolkov\AppData\secret.toml".to_string();`);
  assert.strictEqual(f.length, 1, `expected exactly one finding, got ${JSON.stringify(f)}`);
  assert.strictEqual(f[0].cls, "account-name");
  assert.strictEqual(f[0].value, "mvolkov");
});

test("2. catches the account name regardless of slash style or drive letter", () => {
  for (const s of [
    String.raw`// see C:\Users\mvolkov\Documents\backup`,
    String.raw`// see D:/Users/mvolkov/Documents/backup`,
    String.raw`// see C:\\Users\\mvolkov\\AppData`,
    "// see /home/mvolkov/.config",
    "// see /Users/mvolkov/Library",
  ]) {
    const f = hit(s);
    assert.strictEqual(f.length, 1, `no finding for ${s}: ${JSON.stringify(f)}`);
    assert.strictEqual(f[0].value, "mvolkov", `wrong capture for ${s}`);
  }
});

test("3. the account-name rule is not hardcoded to «mvolkov» — any real name trips it", () => {
  const f = hit(String.raw`// C:\Users\Aleksandr\Desktop\build.log`);
  assert.deepStrictEqual(values(f, "account-name"), ["Aleksandr"]);
});

test("4. allowlisted and placeholder account names stay silent", () => {
  for (const s of [
    String.raw`C:\Users\Public\Documents`,
    String.raw`C:\Users\Default\NTUSER.DAT`,
    String.raw`C:\Users\All Users\app`,
    String.raw`C:\Users\<user>\AppData\Local`,
    String.raw`C:\Users\%USERNAME%\AppData`,
    String.raw`C:\Users\user\AppData\Roaming`,
    "%USERPROFILE%\\AppData\\Local\\TrustTunnel",
    "/home/runner/work/repo",
  ]) {
    assert.deepStrictEqual(hit(s), [], `false positive on ${s}`);
  }
});

// ═══ 2. hostnames ══════════════════════════════════════════════════════════════

test("5. catches a real server hostname in a comment", () => {
  const f = hit('/// e.g. "TrustTunnel (somebox.win)" — matched by name.');
  assert.deepStrictEqual(values(f, "hostname"), ["somebox.win"]);
});

test("6. catches a real hostname in a string literal, including a subdomain", () => {
  const f = hit('        let h = "cdn.somebox.ru:443";');
  assert.deepStrictEqual(values(f, "hostname"), ["cdn.somebox.ru"]);
});

test("7. catches a bare .ru host that is not a documentation domain", () => {
  const f = hit('hostname = "barehost.ru"', "gui-pro/src-tauri/src/x.rs");
  assert.deepStrictEqual(values(f, "hostname"), ["barehost.ru"]);
});

test("8. reserved documentation names and the project's real vendors stay silent", () => {
  for (const s of [
    'const u = "https://example.com/x";',
    'const u = "sni.example.com";',
    'const u = "dns.example";',
    'const u = "host.example.test";',
    'const u = "thing.invalid";',
    'const u = "trusttunnel.local";',
    'const u = "https://api.github.com/repos";',
    'const u = "https://raw.githubusercontent.com/a/b";',
    'const u = "http://www.w3.org/2000/svg";',
    'const u = "https://speed.cloudflare.com/__down";',
    'const u = "http://timestamp.digicert.com";',
  ]) {
    assert.deepStrictEqual(hit(s, "gui-pro/src/x.ts"), [], `false positive on ${s}`);
  }
});

// ═══ 3. IPv4 / IPv6 ════════════════════════════════════════════════════════════

test("9. catches a real routable IPv4", () => {
  const f = hit('    display_host: "93.184.216.34",', "gui-pro/src/x.test.tsx");
  assert.deepStrictEqual(values(f, "ipv4"), ["93.184.216.34"]);
});

test("10. catches a real IP even when it is only a comment aside", () => {
  const f = hit("//   - `93.184.215.14` → octets, prefix remains", "gui-pro/src/shared/ui/x.tsx");
  assert.deepStrictEqual(values(f, "ipv4"), ["93.184.215.14"]);
});

test("11. documentation, private, loopback and known public resolvers stay silent", () => {
  for (const s of [
    'const ip = "203.0.113.7";', // RFC 5737 TEST-NET-3
    'const ip = "198.51.100.4";', // RFC 5737 TEST-NET-2
    'const ip = "192.0.2.1";', //   RFC 5737 TEST-NET-1
    'const ip = "192.168.1.1";',
    'const ip = "10.0.0.0";',
    'const ip = "172.16.4.2";',
    'const ip = "127.0.0.1";',
    'const ip = "0.0.0.0";',
    'const ip = "255.255.255.255";',
    'const ip = "169.254.1.1";',
    'const ip = "8.8.8.8";', //     Google public DNS — product configuration
    'const ip = "8.8.4.4";',
    'const ip = "1.1.1.1";',
    'const ip = "9.9.9.9";', //     Quad9 — a global anycast resolver, not a person
    'const ip = "77.88.8.1";', //   Yandex public DNS — product configuration
    'const ip = "77.88.8.8";',
  ]) {
    assert.deepStrictEqual(hit(s, "gui-pro/src/x.ts"), [], `false positive on ${s}`);
  }
});

test("12. catches a real global IPv6 and stays silent on the documentation prefix", () => {
  assert.deepStrictEqual(
    values(hit('    "tg://proxy?server=2001:db9:5:21::1&port=8443"', "gui-pro/src-tauri/src/x.rs"), "ipv6"),
    ["2001:db9:5:21::1"]
  );
  for (const s of ['let a = "2001:db8:5:21::1";', 'let a = "::1";', 'let a = "fe80::1";', 'let a = "2001:db8::";']) {
    assert.deepStrictEqual(hit(s, "gui-pro/src-tauri/src/x.rs"), [], `false positive on ${s}`);
  }
});

// ═══ 4. e-mail ═════════════════════════════════════════════════════════════════

test("13. catches an e-mail outside the reserved documentation domains", () => {
  const f = hit('  const owner = "ivan.petrov@gmail.com";', "gui-pro/src/x.ts");
  assert.deepStrictEqual(values(f, "email"), ["ivan.petrov@gmail.com"]);
});

test("14. documentation-domain e-mail stays silent", () => {
  for (const s of ['"you@example.com"', '"old@example.org"', '"a@host.example"', '"x@thing.invalid"']) {
    assert.deepStrictEqual(hit(s, "gui-pro/src/x.ts"), [], `false positive on ${s}`);
  }
});

// ═══ 5. THE NOISE CORPUS — the strings that fooled the manual scan ═════════════

test("15. the noise corpus produces exactly zero findings", () => {
  // Every line here is a real shape from this repository that a naive matcher misreads.
  const corpus = [
    ["gui-pro/src/shared/ui/Menu.tsx", "      const y = rect.top + rect.height;"],
    ["gui-pro/src/shared/ui/Menu.tsx", "      dropdown.style.top = `${y}px`;"],
    ["gui-pro/src/shared/ui/Menu.tsx", "      el.style.left = x + 'px';"],
    ["gui-pro/src/x.test.ts", '      expect(k).toBe("notificationcopy.connected.title.ru");'],
    ["scripts/gen-brand-icon.py", "        (256, '128x128@2x.png'),"],
    ["scripts/gen-brand-icon.py", "    32x32.png, 64x64.png, 128x128@2x.png  — taskbar"],
    ["gui-pro/README.md", "Run `npm run test`, see `install.sh` and `i18n-dead-keys.sh`."],
    ["gui-pro/README.md", "Edit `CHANGELOG.md` then `README.md`; the crate is `lifecycle.rs`."],
    ["gui-pro/package.json", '    "vitest": "^4.1.0",'],
    ["gui-pro/package.json", '    "@tauri-apps/cli": "2.10.1",'],
    ["gui-pro/src/x.ts", '  const v = "3.0.0"; const w = "1.2.3.4-beta";'],
    ["gui-pro/src-tauri/src/x.rs", '        let log = "10:01:05 telemt: link";'],
    ["gui-pro/src/x.ts", "  if (Object.is(a, b)) return arr.at(0);"],
    ["gui-pro/src/x.ts", "  expect(fn).to.be.a('function');"],
    ["gui-pro/src/x.ts", "  const n = payload.data.id;"],
    ["gui-pro/src/x.ts", "  return item.name + item.value + item.title;"],
    ["gui-pro/src-tauri/src/x.rs", "    // shrink to fit; see mod.rs and main.rs"],
    ["gui-pro/src/x.ts", '  import styles from "./Card.module.css";'],
    ["gui-pro/src/x.ts", "  const f = new File([b], 'report.zip');"],
    ["gui-pro/src/x.ts", "  el.dataset.id = row.id;"],
  ];
  const noisy = [];
  for (const [file, line] of corpus) {
    for (const f of scanText(line, file)) noisy.push(`${file}: ${f.cls} «${f.value}» ← ${line.trim()}`);
  }
  assert.deepStrictEqual(noisy, [], `noise corpus must be silent:\n  ${noisy.join("\n  ")}`);
});

// ═══ 6. the inline exception marker ════════════════════════════════════════════

test("16. an exception marker WITH a reason suppresses the finding on its line", () => {
  const f = hit('let h = "realhost.win"; // pii-gate-allow: vendor endpoint, documented in ADR-9');
  assert.deepStrictEqual(f, []);
});

test("17. a bare marker with no reason does NOT suppress — it must stay a decision, not a habit", () => {
  const f = hit('let h = "realhost.win"; // pii-gate-allow');
  assert.deepStrictEqual(values(f, "hostname"), ["realhost.win"]);
});

test("18. the marker only covers its own line", () => {
  const text = [
    'let a = "realhost.win"; // pii-gate-allow: intentional',
    'let b = "otherhost.win";',
  ].join("\n");
  const f = scanText(text, "gui-pro/src-tauri/src/x.rs");
  assert.deepStrictEqual(values(f, "hostname"), ["otherhost.win"]);
  assert.strictEqual(f[0].line, 2, "the finding must carry the real 1-based line number");
});

// ═══ 7. scanTree — walking a real directory ════════════════════════════════════

function mkTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pii-gate-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf8");
  }
  return dir;
}

test("19. scanTree finds leaks across a dirty tree and names file and line", () => {
  const dir = mkTree({
    "gui-pro/src/a.ts": 'export const H = "somebox.win";\n',
    "gui-pro/src-tauri/src/b.rs": '// C:\\Users\\mvolkov\\AppData\n',
  });
  try {
    const r = scanTree(dir, { useGit: false });
    assert.strictEqual(r.findings.length, 2, JSON.stringify(r.findings, null, 2));
    assert.ok(r.filesScanned >= 2, `expected the walker to visit both files, saw ${r.filesScanned}`);
    const byFile = Object.fromEntries(r.findings.map((f) => [f.file.replace(/\\/g, "/"), f]));
    assert.strictEqual(byFile["gui-pro/src/a.ts"].value, "somebox.win");
    assert.strictEqual(byFile["gui-pro/src-tauri/src/b.rs"].value, "mvolkov");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("20. A CLEAN TREE PASSES — zero findings, and the walker really did look", () => {
  const dir = mkTree({
    "gui-pro/src/a.ts": 'export const H = "sni.example.com";\nexport const I = "203.0.113.9";\n',
    "gui-pro/src/b.tsx": 'const y = rect.top;\nconst m = "you@example.com";\n',
    "gui-pro/src-tauri/src/c.rs": '// C:\\Users\\<user>\\AppData\nlet dns = "9.9.9.9";\n',
    "gui-pro/README.md": "See `install.sh` and `lifecycle.rs`.\n",
  });
  try {
    const r = scanTree(dir, { useGit: false });
    assert.deepStrictEqual(r.findings, [], JSON.stringify(r.findings, null, 2));
    assert.strictEqual(r.filesScanned, 4, `the walker must have opened all four files, saw ${r.filesScanned}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("21. vendored upstream, local-only planning notes and lockfiles are out of scope", () => {
  const dir = mkTree({
    "third-party/x/a.c": '// somebox.win\n',
    "core/test/b.cpp": '// somebox.win\n',
    ".planning/notes.md": "server somebox.win is the repro box\n",
    "memory/v3/x.md": "server somebox.win\n",
    "gui-pro/package-lock.json": '{"x":"somebox.win"}\n',
    "gui-pro/src-tauri/target/debug/build.log": "somebox.win\n",
    "gui-pro/node_modules/p/index.js": 'var h = "somebox.win";\n',
  });
  try {
    const r = scanTree(dir, { useGit: false });
    assert.deepStrictEqual(r.findings, [], JSON.stringify(r.findings, null, 2));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("22. scanTree reports how many exceptions are in use, so they cannot pile up unseen", () => {
  const dir = mkTree({
    "gui-pro/src/a.ts": 'const H = "realhost.win"; // pii-gate-allow: vendor API host, see ADR-9\n',
  });
  try {
    const r = scanTree(dir, { useGit: false });
    assert.deepStrictEqual(r.findings, []);
    assert.strictEqual(r.exceptions.length, 1, JSON.stringify(r.exceptions));
    assert.match(r.exceptions[0].reason, /vendor API host/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ═══ 8. THE BASELINE — accepted debt, not a mute button ════════════════════════

/*
 * The baseline exists because the gate's rule («only documentation-reserved names») is right for
 * new and changed code but wrong applied backwards to a tree full of harmless invented literals.
 * The danger of any such file is obvious: it can quietly become the place everything goes. These
 * arms pin the four properties that stop that, so a later loosening turns them red.
 */

/** A finding, as `scanText` produces one. */
const F = (cls, file, value, line = 1) => ({ cls, file, value, line, column: 1, rule: "t" });

const BASE = [
  "[reasons]",
  "1.2.3.4 | the count-to-four placeholder",
  "",
  "[entries]",
  "ipv4 | gui-pro/src/a.ts | 1.2.3.4 | 2",
].join("\n");

test("24. a baselined value in its own file, at its own count, passes", () => {
  const b = parseBaseline(BASE);
  const r = applyBaseline([F("ipv4", "gui-pro/src/a.ts", "1.2.3.4"), F("ipv4", "gui-pro/src/a.ts", "1.2.3.4")], b);
  assert.deepStrictEqual(r.unaccepted, []);
  assert.deepStrictEqual(r.grown, []);
  assert.deepStrictEqual(r.stale, []);
  assert.deepStrictEqual(r.unreasoned, []);
});

test("25. THE SAME value in a DIFFERENT file still fails — the baseline is pinned to a place", () => {
  const b = parseBaseline(BASE);
  const r = applyBaseline([F("ipv4", "gui-pro/src/a.ts", "1.2.3.4"), F("ipv4", "gui-pro/src/b.ts", "1.2.3.4")], b);
  assert.deepStrictEqual(r.unaccepted.map((u) => u.file), ["gui-pro/src/b.ts"]);
  // …and the accepted file is still accepted: this is not an all-or-nothing failure.
  assert.deepStrictEqual(r.grown, []);
});

test("26. ONE MORE occurrence in an accepted file fails — the baseline is pinned to a count", () => {
  const b = parseBaseline(BASE);
  const three = [1, 2, 3].map(() => F("ipv4", "gui-pro/src/a.ts", "1.2.3.4"));
  const r = applyBaseline(three, b);
  assert.deepStrictEqual(r.grown.map((g) => `${g.was}->${g.now}`), ["2->3"]);
});

test("27. a value nobody listed fails, whatever else is in the baseline", () => {
  const b = parseBaseline(BASE);
  const r = applyBaseline([F("hostname", "gui-pro/src/a.ts", "somebox.win")], b);
  assert.deepStrictEqual(r.unaccepted.map((u) => u.value), ["somebox.win"]);
});

test("28. a baseline entry the scan no longer finds is STALE and fails — the list must shrink", () => {
  const b = parseBaseline(BASE);
  const r = applyBaseline([F("ipv4", "gui-pro/src/a.ts", "1.2.3.4")], b); // one, baseline says two
  assert.deepStrictEqual(r.stale.map((s) => `${s.was}->${s.now}`), ["2->1"]);
});

test("29. a TODO reason is REFUSED — regenerating alone cannot make the gate green", () => {
  const b = parseBaseline(BASE.replace("the count-to-four placeholder", "TODO: state why"));
  const r = applyBaseline([F("ipv4", "gui-pro/src/a.ts", "1.2.3.4"), F("ipv4", "gui-pro/src/a.ts", "1.2.3.4")], b);
  assert.strictEqual(r.unreasoned.length, 1, JSON.stringify(r.unreasoned));
  assert.match(r.unreasoned[0].why, /TODO/);
});

test("30. an entry with no reason line at all is refused too", () => {
  const b = parseBaseline("[entries]\nipv4 | gui-pro/src/a.ts | 1.2.3.4 | 1\n");
  const r = applyBaseline([F("ipv4", "gui-pro/src/a.ts", "1.2.3.4")], b);
  assert.deepStrictEqual(r.unreasoned.map((u) => u.value), ["1.2.3.4"]);
});

test("31. regenerating carries written reasons forward and writes TODO only for new values", () => {
  const previous = parseBaseline(BASE);
  const text = formatBaseline(
    [F("ipv4", "gui-pro/src/a.ts", "1.2.3.4"), F("hostname", "gui-pro/src/a.ts", "somebox.win")],
    previous
  );
  assert.match(text, /1\.2\.3\.4 \| the count-to-four placeholder/, "an existing reason must survive");
  assert.match(text, /somebox\.win \| TODO/, "a new value must arrive as an unanswered TODO");
  // The regenerated file must itself be refused until the TODO is answered.
  const r = applyBaseline(
    [F("ipv4", "gui-pro/src/a.ts", "1.2.3.4"), F("hostname", "gui-pro/src/a.ts", "somebox.win")],
    parseBaseline(text)
  );
  assert.deepStrictEqual(r.unreasoned.map((u) => u.value), ["somebox.win"]);
});

test("32. the baseline carries no line numbers — an edit above a finding must not churn it", () => {
  const text = formatBaseline([F("ipv4", "gui-pro/src/a.ts", "1.2.3.4", 12)], parseBaseline(BASE));
  const same = formatBaseline([F("ipv4", "gui-pro/src/a.ts", "1.2.3.4", 4210)], parseBaseline(BASE));
  assert.strictEqual(
    text,
    same,
    "moving a finding from line 12 to line 4210 changed the baseline — then every source edit " +
      "produces a diff full of moved lines, and an added exception hides in the noise"
  );
});

/*
 * The baseline file travels to the release branch and CI runs this gate there — on a tree the
 * ritual has stripped of every story-tier file. These arms pin the one exemption that makes that
 * work and the two boundaries that keep it from becoming a general «missing file is fine».
 */
const STORY_BASE = [
  "[reasons]",
  "1.2.3.4 | the count-to-four placeholder",
  "",
  "[entries]",
  "ipv4 | gui-pro/src/components/x/Demo.stories.tsx | 1.2.3.4 | 1",
].join("\n");

test("35. a story-tier row on a RELEASE-shaped tree is left at home, not stale", () => {
  const r = applyBaseline([], parseBaseline(STORY_BASE), { files: ["gui-pro/src/a.ts", "scripts/x.cjs"] });
  assert.deepStrictEqual(r.stale, [], "a story file absent from a release tree is the ritual working, not dead debt");
  assert.deepStrictEqual(r.leftHome.map((h) => h.file), ["gui-pro/src/components/x/Demo.stories.tsx"]);
});

test("36. the same row on a WORKING tree (story tier present) is still stale — a deleted story leaves a dead row", () => {
  const files = ["gui-pro/src/a.ts", "gui-pro/src/components/y/Other.stories.tsx"];
  const r = applyBaseline([], parseBaseline(STORY_BASE), { files });
  assert.deepStrictEqual(r.stale.map((s) => s.file), ["gui-pro/src/components/x/Demo.stories.tsx"]);
  assert.deepStrictEqual(r.leftHome, []);
});

test("37. the exemption is for the story tier only — an absent SOURCE file is stale on any tree", () => {
  const b = parseBaseline(STORY_BASE.replace("gui-pro/src/components/x/Demo.stories.tsx", "gui-pro/src/gone.ts"));
  const r = applyBaseline([], b, { files: ["gui-pro/src/a.ts"] }); // release-shaped: no story file
  assert.deepStrictEqual(r.stale.map((s) => s.file), ["gui-pro/src/gone.ts"]);
  assert.deepStrictEqual(r.leftHome, []);
});

test("38. --no-git scans a directory that is not a checkout — the extracted commit about to be pushed", () => {
  const { spawnSync } = require("child_process");
  const gate = path.join(__dirname, "pii-gate.cjs");
  const dir = mkTree({ "gui-pro/src/a.ts": 'export const H = "somebox.win";\n' });
  try {
    const walked = spawnSync(process.execPath, [gate, "--no-git", dir], { encoding: "utf8" });
    assert.strictEqual(walked.status, 1, `--no-git must find the leak and fail:\n${walked.stdout}${walked.stderr}`);
    assert.match(walked.stdout, /somebox\.win/);
    // Without the flag the same directory cannot be listed by git — the gate must say it could
    // not run (2), never report a clean tree (0).
    const asked = spawnSync(process.execPath, [gate, dir], { encoding: "utf8" });
    assert.strictEqual(asked.status, 2, `a non-checkout without --no-git must exit 2:\n${asked.stdout}${asked.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("33. the checked-in baseline is answered in full — no TODO reaches the repository", () => {
  const p = path.join(__dirname, "pii-baseline.txt");
  assert.ok(fs.existsSync(p), "scripts/pii-baseline.txt is missing — the gate would treat the whole tree as new");
  const b = parseBaseline(fs.readFileSync(p, "utf8"));
  assert.ok(b.entries.size > 0, "the checked-in baseline has no entries");
  const todo = [...b.reasons].filter(([, r]) => r.startsWith("TODO")).map(([v]) => v);
  assert.deepStrictEqual(todo, [], "these baselined values still have no written reason");
});

// ═══ 9. THIS FILE'S OWN FIXTURES ═══════════════════════════════════════════════

/*
 * Every value this file's own source trips a detector on, and why it identifies nobody.
 *
 * `pii-gate.cjs` cannot scan this file — SKIP_BASENAMES holds its basename, because a leak
 * detector's positive arms are made of leak shapes and scanning them would report all of them.
 * That is a permanent blind spot on a file that travels to the public branch, and the blind spot
 * already cost once: the first draft of this suite used real values, and nothing caught it,
 * because the only scanner that could had been excused.
 *
 * This map is the light in that corner. Test 34 scans this file and fails on any value not listed
 * here — so pasting a real hostname into a new fixture goes red, and the only route to green is a
 * diff line in this map that a reviewer reads as «this value is safe to publish», with the reason
 * next to it. Membership, not equality: deleting a fixture is free, adding a value is not.
 */
const SYNTHETIC_FIXTURES = new Map([
  ["mvolkov", "invented surname-shaped account name; matches no user on any machine"],
  ["Aleksandr", "a bare given name, the 'any unlisted name trips the rule' arm"],
  ["somebox.win", "invented host under the gTLD both leaked names happened to use"],
  ["cdn.somebox.ru", "invented subdomain of the same invented host"],
  ["barehost.ru", "invented bare .ru host — the 'not a documentation domain' arm"],
  ["realhost.win", "invented host for the inline-exception-marker arms"],
  ["otherhost.win", "invented host proving the marker covers only its own line"],
  ["93.184.216.34", "the address IANA published for example.com — routable, nobody's"],
  ["93.184.215.14", "the same, its later value; routable so the detector must fire"],
  ["2001:db9:5:21::1", "one hex digit off RFC 3849's 2001:db8 — unallocated, hence detectable"],
  ["ivan.petrov@gmail.com", "the Russian John-Doe name; no such mailbox is claimed"],
  ["1.2.3.4", "the count-to-four placeholder, used by the baseline arms above"],
]);

test("34. every value in this file's own source is a declared synthetic fixture", () => {
  const src = fs.readFileSync(__filename, "utf8");
  // Scanned under this file's real path, so the extension-dependent rules behave as they would
  // in a tree scan. `scanText` bypasses SKIP_BASENAMES on purpose — that is the whole point.
  const found = scanText(src, "scripts/pii-gate.test.cjs");
  const undeclared = found
    .filter((f) => !SYNTHETIC_FIXTURES.has(f.value))
    .map((f) => `line ${f.line}: ${f.cls} «${f.value}»`);
  assert.deepStrictEqual(
    undeclared,
    [],
    "a value in this file trips the gate and is not declared synthetic. Either replace it with a " +
      "documentation-reserved equivalent, or — if it really identifies nobody — add it to " +
      `SYNTHETIC_FIXTURES with the reason:\n  ${undeclared.join("\n  ")}`
  );
  // And the scan must really have looked: this file is ~35 leak shapes by construction, so a
  // matcher broken into always-false would sail through the assertion above.
  assert.ok(
    found.length >= 20,
    `expected this file's own fixtures to trip the detectors many times, saw ${found.length} — ` +
      "either the fixtures were removed or a detector stopped detecting"
  );
});

// ─── report ────────────────────────────────────────────────────────────────────
const total = passed + failures.length;
console.log("");
console.log(`  tests     : ${passed}/${total} passed`);
if (failures.length) {
  console.log("RESULT: FAILURE");
  process.exit(1);
}
console.log("RESULT: PASS");
process.exit(0);

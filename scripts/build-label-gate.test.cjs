/*
 * Self-tests for build-label-gate.cjs.
 *
 * Fixtures are synthetic: a temp directory holding a fake `dist/assets/*.js` chunk (plain text,
 * never a real Vite build) and a fake "exe" — random bytes with the ASCII asset key spliced in,
 * the same way a Tauri binary stores an uncompressed asset key next to a Brotli-compressed body.
 * The suite runs without `npm run build` or `npx tauri build` and never touches a real installer.
 *
 * Run: node scripts/build-label-gate.test.cjs   (npm run label:test from gui-pro/)
 */
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const GATE = path.join(__dirname, "build-label-gate.cjs");

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

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tt-label-"));
}

function run(args) {
  return spawnSync(process.execPath, [GATE, ...args], { encoding: "utf8" });
}

/** Writes dist/assets/<chunkName> with the given source text. */
function writeChunk(distDir, chunkName, text) {
  const assetsDir = path.join(distDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, chunkName), text, "utf8");
}

/** A fake exe: random bytes with the ASCII asset key `assets/<chunk>` spliced in for each name. */
function writeFakeExe(exePath, chunkNames) {
  const parts = [crypto.randomBytes(256)];
  for (const chunk of chunkNames) {
    parts.push(Buffer.from(`assets/${chunk}`, "latin1"));
    parts.push(crypto.randomBytes(64));
  }
  fs.writeFileSync(exePath, Buffer.concat(parts));
}

test("1. non-empty literal in a chunk the exe embeds: exit 1, names the label and the chunk, ignores an unrelated 6-char token", () => {
  const dir = tempDir();
  try {
    writeChunk(dir, "main-AAAA1111.js", 'r.jsx(X,{version:i,buildHash:"lbl9q2"}); const k="zz9x8y";');
    const exePath = path.join(dir, "fake.exe");
    writeFakeExe(exePath, ["main-AAAA1111.js"]);

    const result = run(["--dist", dir, "--exe", exePath]);
    assert.strictEqual(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /lbl9q2/);
    assert.match(result.stdout, /main-AAAA1111\.js/);
    assert.ok(!result.stdout.includes("zz9x8y"), `must not report the unrelated token: ${result.stdout}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('2. empty literal (buildHash:"") in an embedded chunk: exit 0, RESULT: PASS', () => {
  const dir = tempDir();
  try {
    writeChunk(dir, "main-AAAA1111.js", 'r.jsx(X,{version:i,buildHash:""}); const k="zz9x8y";');
    const exePath = path.join(dir, "fake.exe");
    writeFakeExe(exePath, ["main-AAAA1111.js"]);

    const result = run(["--dist", dir, "--exe", exePath]);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /RESULT: PASS/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("3. dist chunk not embedded in the exe: exit 2 STALE, even when the label is empty", () => {
  const dir = tempDir();
  try {
    writeChunk(dir, "main-AAAA1111.js", 'r.jsx(X,{version:i,buildHash:""});');
    const exePath = path.join(dir, "fake.exe");
    writeFakeExe(exePath, ["main-BBBB2222.js"]); // exe embeds a DIFFERENT chunk than dist holds

    const result = run(["--dist", dir, "--exe", exePath]);
    assert.strictEqual(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /STALE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("4. only the destructuring form (no string literal) present: exit 2 CANNOT MEASURE", () => {
  const dir = tempDir();
  try {
    writeChunk(dir, "main-CCCC3333.js", "function R1({version:e,buildHash:t}){return e+t}");
    const exePath = path.join(dir, "fake.exe");
    writeFakeExe(exePath, ["main-CCCC3333.js"]);

    const result = run(["--dist", dir, "--exe", exePath]);
    assert.strictEqual(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /CANNOT MEASURE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("5. single-quote and backtick literal forms both count as a compiled-in label: exit 1", () => {
  for (const [chunk, src] of [
    ["main-DDDD4444.js", "r.jsx(X,{version:i,buildHash:'lbl9q2'});"],
    ["main-EEEE5555.js", "r.jsx(X,{version:i,buildHash:`lbl9q2`});"],
  ]) {
    const dir = tempDir();
    try {
      writeChunk(dir, chunk, src);
      const exePath = path.join(dir, "fake.exe");
      writeFakeExe(exePath, [chunk]);
      const result = run(["--dist", dir, "--exe", exePath]);
      assert.strictEqual(result.status, 1, `${chunk}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /lbl9q2/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('6. adjacency edge: buildHash:"" passes, buildHash:" " (a single space) fails — the empty/non-empty boundary is exact', () => {
  const passDir = tempDir();
  try {
    writeChunk(passDir, "main-FFFF6666.js", 'r.jsx(X,{version:i,buildHash:""});');
    const exePath = path.join(passDir, "fake.exe");
    writeFakeExe(exePath, ["main-FFFF6666.js"]);
    const result = run(["--dist", passDir, "--exe", exePath]);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  } finally {
    fs.rmSync(passDir, { recursive: true, force: true });
  }

  const failDir = tempDir();
  try {
    writeChunk(failDir, "main-FFFF6666.js", 'r.jsx(X,{version:i,buildHash:" "});');
    const exePath = path.join(failDir, "fake.exe");
    writeFakeExe(exePath, ["main-FFFF6666.js"]);
    const result = run(["--dist", failDir, "--exe", exePath]);
    assert.strictEqual(result.status, 1, result.stdout + result.stderr);
  } finally {
    fs.rmSync(failDir, { recursive: true, force: true });
  }
});

test("7. two labelled chunks, both embedded: exit 1, both reported, main-... line before trayMenu-... line (ordering edge)", () => {
  const dir = tempDir();
  try {
    writeChunk(dir, "main-GGGG7777.js", 'r.jsx(X,{version:i,buildHash:"mainlbl"});');
    writeChunk(dir, "trayMenu-HHHH8888.js", 'r.jsx(Y,{version:i,buildHash:"traylbl"});');
    const exePath = path.join(dir, "fake.exe");
    writeFakeExe(exePath, ["main-GGGG7777.js", "trayMenu-HHHH8888.js"]);
    const result = run(["--dist", dir, "--exe", exePath]);
    assert.strictEqual(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /mainlbl/);
    assert.match(result.stdout, /traylbl/);
    const mainLine = result.stdout.indexOf("main-GGGG7777.js");
    const trayLine = result.stdout.indexOf("trayMenu-HHHH8888.js");
    assert.ok(mainLine !== -1 && trayLine !== -1 && mainLine < trayLine, result.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("8. missing dist directory: exit 2 CANNOT MEASURE", () => {
  const dir = tempDir();
  const missingDist = path.join(dir, "does-not-exist");
  const exePath = path.join(dir, "fake.exe");
  try {
    writeFakeExe(exePath, ["main-x.js"]);
    const result = run(["--dist", missingDist, "--exe", exePath]);
    assert.strictEqual(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /CANNOT MEASURE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("9. dist/assets exists but holds no .js files: exit 2 CANNOT MEASURE", () => {
  const dir = tempDir();
  try {
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "assets", "logo.svg"), "<svg/>");
    const exePath = path.join(dir, "fake.exe");
    writeFakeExe(exePath, ["logo.svg"]);
    const result = run(["--dist", dir, "--exe", exePath]);
    assert.strictEqual(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /CANNOT MEASURE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("10. missing exe (a literal exists, so the gate reaches the exe-read step): exit 2 CANNOT MEASURE", () => {
  const dir = tempDir();
  try {
    writeChunk(dir, "main-IIII9999.js", 'r.jsx(X,{version:i,buildHash:"lbl9q2"});');
    const exePath = path.join(dir, "does-not-exist.exe");
    const result = run(["--dist", dir, "--exe", exePath]);
    assert.strictEqual(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /CANNOT MEASURE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("11. spawned with VITE_BUILD_HASH set in the environment over a clean fixture: exit 0, stdout never names the env value (P-02-04-1)", () => {
  const dir = tempDir();
  try {
    writeChunk(dir, "main-JJJJ0000.js", 'r.jsx(X,{version:i,buildHash:""});');
    const exePath = path.join(dir, "fake.exe");
    writeFakeExe(exePath, ["main-JJJJ0000.js"]);
    const result = spawnSync(
      process.execPath,
      [GATE, "--dist", dir, "--exe", exePath],
      { encoding: "utf8", env: { ...process.env, VITE_BUILD_HASH: "envonly" } },
    );
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok(!result.stdout.includes("envonly"), `must never name the env var value: ${result.stdout}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("12. idempotency: two runs on the same fixture give identical stdout and exit code, and the fixture directory is unchanged", () => {
  const dir = tempDir();
  try {
    writeChunk(dir, "main-KKKK1111.js", 'r.jsx(X,{version:i,buildHash:"lbl9q2"});');
    const exePath = path.join(dir, "fake.exe");
    writeFakeExe(exePath, ["main-KKKK1111.js"]);

    const snapshot = () => {
      const walk = (d) =>
        fs
          .readdirSync(d, { withFileTypes: true })
          .flatMap((entry) => {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) return walk(full);
            const stat = fs.statSync(full);
            return [`${path.relative(dir, full)}:${stat.size}:${stat.mtimeMs}`];
          })
          .sort();
      return walk(dir);
    };

    const before = snapshot();
    const first = run(["--dist", dir, "--exe", exePath]);
    const second = run(["--dist", dir, "--exe", exePath]);
    const after = snapshot();

    assert.strictEqual(first.status, second.status);
    assert.strictEqual(first.stdout, second.stdout);
    assert.deepStrictEqual(before, after, "the gate must write nothing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("13. source anchor: AboutPanel.tsx passes buildHash={__BUILD_HASH__} to AboutHero", () => {
  const text = fs.readFileSync(
    path.join(__dirname, "..", "gui-pro", "src", "components", "AboutPanel.tsx"),
    "utf8",
  );
  assert.ok(text.includes("buildHash={__BUILD_HASH__}"), "AboutPanel call-site anchor drifted");
});

test("14. source anchor: AboutHero.tsx calls buildVersionLabel(version, buildHash)", () => {
  const text = fs.readFileSync(
    path.join(__dirname, "..", "gui-pro", "src", "components", "about", "AboutHero.tsx"),
    "utf8",
  );
  assert.ok(text.includes("buildVersionLabel(version, buildHash)"), "AboutHero call-site anchor drifted");
});

test("15. source anchor: vite.config.ts defines __BUILD_HASH__ from the VITE_BUILD_HASH-derived constant via JSON.stringify", () => {
  const text = fs.readFileSync(path.join(__dirname, "..", "gui-pro", "vite.config.ts"), "utf8");
  assert.ok(text.includes("__BUILD_HASH__: JSON.stringify(BUILD_HASH)"), "vite.config.ts define anchor drifted");
  assert.ok(text.includes("process.env.VITE_BUILD_HASH"), "vite.config.ts env-var read anchor drifted");
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

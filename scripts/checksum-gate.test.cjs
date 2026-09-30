/*
 * Self-tests for checksum-gate.cjs.
 *
 * Fixtures are synthetic: a temp directory holding a fake installer of random bytes, named
 * `TrustTunnel Client Pro_9.9.9_x64-setup.exe` (an invented version, never the real 3.0.0 one),
 * so the suite runs without `npx tauri build` and never touches a real build artifact or a real
 * account/machine name. `npm run pii:check` scans this file.
 *
 * Run: node scripts/checksum-gate.test.cjs   (npm run checksum:test from gui-pro/)
 */
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { digestLine, firstToken, isHexSha256, isProInstallerName } = require("./checksum-gate.cjs");
const GATE = path.join(__dirname, "checksum-gate.cjs");
const UPDATER_RS = path.join(__dirname, "..", "gui-pro", "src-tauri", "src", "commands", "updater.rs");

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "tt-checksum-"));
}
function run(args) {
  return spawnSync(process.execPath, [GATE, ...args], { encoding: "utf8" });
}

const INSTALLER_NAME = "TrustTunnel Client Pro_9.9.9_x64-setup.exe";

test("1. digestLine: lowercased hex + two spaces + name + newline, first token is a valid 64-hex digest under 4096 bytes", () => {
  const hex = "AB".repeat(32); // 64 chars, deliberately upper-case to prove lowering
  const line = digestLine(hex, INSTALLER_NAME);
  assert.strictEqual(line, `${hex.toLowerCase()}  ${INSTALLER_NAME}\n`);
  const token = firstToken(line);
  assert.ok(isHexSha256(token), `first token must pass isHexSha256: ${token}`);
  assert.ok(Buffer.byteLength(line, "utf8") < 4096, "digest line must stay under 4096 bytes");
});

test("2. --write on a fixture dir creates <installer>.sha256 matching an independent hash; a following verify PASSes", () => {
  const dir = tempDir();
  try {
    const bytes = crypto.randomBytes(4096);
    fs.writeFileSync(path.join(dir, INSTALLER_NAME), bytes);
    const expected = crypto.createHash("sha256").update(bytes).digest("hex");

    const writeResult = run(["--write", dir]);
    assert.strictEqual(writeResult.status, 0, writeResult.stdout + writeResult.stderr);
    const shaPath = path.join(dir, `${INSTALLER_NAME}.sha256`);
    assert.ok(fs.existsSync(shaPath), "the gate must create <installer>.sha256 next to it");
    const written = fs.readFileSync(shaPath, "utf8");
    const token = firstToken(written);
    assert.strictEqual(token.toLowerCase(), expected, "written digest must equal an independently computed sha256");

    const verifyResult = run([dir]);
    assert.strictEqual(verifyResult.status, 0, verifyResult.stdout + verifyResult.stderr);
    assert.match(verifyResult.stdout, /RESULT: PASS/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("3. the written file's name minus .sha256 passes isProInstallerName — the same rule updater.rs applies", () => {
  assert.ok(isProInstallerName(INSTALLER_NAME), INSTALLER_NAME);
  assert.ok(!isProInstallerName("TrustTunnel Client Light_9.9.9_x64-setup.exe"), "Light must not pass the Pro rule");
});

test("4. source-anchor contract: updater.rs still spells the asset name, the digest parse and the length check this gate conforms to", () => {
  const text = fs.readFileSync(UPDATER_RS, "utf8");
  assert.ok(text.includes('format!("{installer}.sha256")'), "asset name derivation drifted");
  assert.ok(text.includes("text.split_whitespace().next()"), "digest-token parse drifted");
  assert.ok(text.includes("s.len() == 64"), "hex-length check drifted");
});

test("5. a missing bundle directory is CANNOT MEASURE (exit 2), never a silent pass", () => {
  const dir = tempDir();
  const missing = path.join(dir, "does-not-exist");
  fs.rmSync(dir, { recursive: true, force: true });
  const result = run([missing]);
  assert.strictEqual(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /CANNOT MEASURE/);
});

test("6. missing .sha256 next to an installer: verify exit 1, stdout names the expected file and says missing", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, INSTALLER_NAME), crypto.randomBytes(1024));
    const result = run([dir]);
    assert.strictEqual(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`${INSTALLER_NAME}.sha256`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.stdout, /missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("7. stale digest (write, then flip one installer byte): verify exit 1, stdout names both the recorded and computed digest", () => {
  const dir = tempDir();
  try {
    const bytes = crypto.randomBytes(1024);
    const installerPath = path.join(dir, INSTALLER_NAME);
    fs.writeFileSync(installerPath, bytes);
    const staleDigest = crypto.createHash("sha256").update(bytes).digest("hex");
    assert.strictEqual(run(["--write", dir]).status, 0);

    bytes[0] = bytes[0] ^ 0xff; // flip one byte after the digest was recorded
    fs.writeFileSync(installerPath, bytes);
    const freshDigest = crypto.createHash("sha256").update(bytes).digest("hex");

    const result = run([dir]);
    assert.strictEqual(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(staleDigest));
    assert.match(result.stdout, new RegExp(freshDigest));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("8. upper-case digest in the file: verify exit 0 (case-insensitive, like verify_checksum)", () => {
  const dir = tempDir();
  try {
    const bytes = crypto.randomBytes(1024);
    fs.writeFileSync(path.join(dir, INSTALLER_NAME), bytes);
    const hex = crypto.createHash("sha256").update(bytes).digest("hex");
    fs.writeFileSync(path.join(dir, `${INSTALLER_NAME}.sha256`), digestLine(hex.toUpperCase(), INSTALLER_NAME));
    const result = run([dir]);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /RESULT: PASS/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("9. malformed first token (63 hex chars; 64 chars with a non-hex letter; empty file): verify exit 1 in every case", () => {
  const cases = ["a".repeat(63), `${"a".repeat(63)}g`, ""];
  for (const body of cases) {
    const dir = tempDir();
    try {
      fs.writeFileSync(path.join(dir, INSTALLER_NAME), crypto.randomBytes(1024));
      fs.writeFileSync(path.join(dir, `${INSTALLER_NAME}.sha256`), body);
      const result = run([dir]);
      assert.strictEqual(result.status, 1, `body=${JSON.stringify(body)}: ${result.stdout}${result.stderr}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("10. .sha256 larger than 4096 bytes: verify exit 1 (the updater refuses to read that much)", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, INSTALLER_NAME), crypto.randomBytes(1024));
    fs.writeFileSync(path.join(dir, `${INSTALLER_NAME}.sha256`), "a".repeat(4097));
    const result = run([dir]);
    assert.strictEqual(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /4096/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("11. empty dir, or a dir holding only a Light installer: exit 2 CANNOT MEASURE", () => {
  const emptyDir = tempDir();
  try {
    const result = run([emptyDir]);
    assert.strictEqual(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /CANNOT MEASURE/);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }

  const lightDir = tempDir();
  try {
    fs.writeFileSync(path.join(lightDir, "TrustTunnel Client Light_9.9.9_x64-setup.exe"), crypto.randomBytes(1024));
    const result = run([lightDir]);
    assert.strictEqual(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /CANNOT MEASURE/);
  } finally {
    fs.rmSync(lightDir, { recursive: true, force: true });
  }
});

test("12. two Pro installers: exit 2 naming both, in both modes; write mode creates no .sha256", () => {
  const dir = tempDir();
  try {
    const nameA = "TrustTunnel Client Pro_9.9.8_x64-setup.exe";
    const nameB = "TrustTunnel Client Pro_9.9.9_x64-setup.exe";
    fs.writeFileSync(path.join(dir, nameA), crypto.randomBytes(1024));
    fs.writeFileSync(path.join(dir, nameB), crypto.randomBytes(1024));

    const verifyResult = run([dir]);
    assert.strictEqual(verifyResult.status, 2, verifyResult.stdout + verifyResult.stderr);
    assert.match(verifyResult.stdout, new RegExp(nameA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(verifyResult.stdout, new RegExp(nameB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const writeResult = run(["--write", dir]);
    assert.strictEqual(writeResult.status, 2, writeResult.stdout + writeResult.stderr);
    assert.ok(!fs.existsSync(path.join(dir, `${nameA}.sha256`)), "write mode must not create a .sha256 when ambiguous");
    assert.ok(!fs.existsSync(path.join(dir, `${nameB}.sha256`)), "write mode must not create a .sha256 when ambiguous");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("13. --write twice gives a byte-identical file and leaves no *.tmp-* file in the directory", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, INSTALLER_NAME), crypto.randomBytes(1024));
    assert.strictEqual(run(["--write", dir]).status, 0);
    const first = fs.readFileSync(path.join(dir, `${INSTALLER_NAME}.sha256`));
    assert.strictEqual(run(["--write", dir]).status, 0);
    const second = fs.readFileSync(path.join(dir, `${INSTALLER_NAME}.sha256`));
    assert.ok(first.equals(second), "the second --write must produce a byte-identical file");
    const leftoverTmp = fs.readdirSync(dir).filter((n) => n.includes(".tmp-"));
    assert.deepStrictEqual(leftoverTmp, [], `no tmp file must survive a --write: ${leftoverTmp}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("14. verify never changes the directory: a snapshot of names + sizes is equal before and after a failing verify", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, INSTALLER_NAME), crypto.randomBytes(1024));
    // No .sha256 written -> this verify call is expected to FAIL.
    const snapshot = (d) =>
      fs
        .readdirSync(d)
        .sort()
        .map((n) => `${n}:${fs.statSync(path.join(d, n)).size}`);
    const before = snapshot(dir);
    const result = run([dir]);
    assert.strictEqual(result.status, 1, result.stdout + result.stderr);
    const after = snapshot(dir);
    assert.deepStrictEqual(before, after, "a failing verify must not modify the directory");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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

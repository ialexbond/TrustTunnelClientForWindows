"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { EXPECTED_VERSION, EXPECTED_POLICY_VERSION, DEFAULT_CORE, validateWindowsExecutable, verifyCore } = require("./core-compatibility-gate.cjs");

// Synthetic header fixtures never execute. Query results are injected, so this
// suite is safe on CI with no Windows core, network, or user settings.
function executable() {
  const bytes = Buffer.alloc(1024);
  bytes.write("MZ");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80);
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(240, 0x94);
  bytes.writeUInt16LE(0x22, 0x96);
  bytes.writeUInt16LE(0x20b, 0x98);
  return bytes;
}

function fixture(overrides = {}, bytes = executable()) {
  const calls = [];
  const results = {
    "--version": { status: 0, stdout: `trusttunnel_client ${EXPECTED_VERSION}\r\n` },
    "--help": { status: 1, stdout: "  --routing-policy-version  Print supported policy\r\n" },
    "--routing-policy-version": { status: 0, stdout: `${EXPECTED_POLICY_VERSION}\r\n` },
    ...overrides,
  };
  return {
    calls,
    options: {
      platform: "win32",
      readFile: () => bytes,
      probe: (_file, flag) => { calls.push(flag); return results[flag]; },
    },
  };
}

test("matching Windows core reports its measured hash and only uses three read-only queries", () => {
  const bytes = executable();
  const { calls, options } = fixture({}, bytes);
  const result = verifyCore(DEFAULT_CORE, options);
  assert.deepEqual(calls, ["--version", "--help", "--routing-policy-version"]);
  assert.equal(result.version, "1.1.11");
  assert.equal(result.policyVersion, "1");
  assert.equal(result.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
});

test("installed 1.1.7 is rejected before any fork-only flag is sent", () => {
  const { calls, options } = fixture({ "--version": { status: 0, stdout: "trusttunnel_client 1.1.7\n" } });
  assert.throws(() => verifyCore(DEFAULT_CORE, options), /must report trusttunnel_client 1\.1\.11/);
  assert.deepEqual(calls, ["--version"]);
});

test("official 1.1.11 without the fork capability is rejected without querying an unknown flag", () => {
  const { calls, options } = fixture({ "--help": { status: 1, stdout: "--help\n--version\n" } });
  assert.throws(() => verifyCore(DEFAULT_CORE, options), /does not advertise/);
  assert.deepEqual(calls, ["--version", "--help"]);
});

for (const policy of ["0", "2", "", "1\nunexpected text"]) {
  test(`unsupported or malformed policy response ${JSON.stringify(policy)} fails`, () => {
    const { options } = fixture({ "--routing-policy-version": { status: 0, stdout: policy } });
    assert.throws(() => verifyCore(DEFAULT_CORE, options), /must support routing policy 1/);
  });
}

test("capability flag must be a complete advertised option", () => {
  const { calls, options } = fixture({ "--help": { status: 0, stdout: "--routing-policy-version-future" } });
  assert.throws(() => verifyCore(DEFAULT_CORE, options), /does not advertise/);
  assert.deepEqual(calls, ["--version", "--help"]);
});

for (const failure of [{ status: null, error: new Error("timeout") }, { status: null, signal: "SIGTERM" }, { status: 7, stdout: "1" }]) {
  test(`failed query is rejected (${failure.error ? "timeout" : failure.signal || failure.status})`, () => {
    const { options } = fixture({ "--version": failure });
    assert.throws(() => verifyCore(DEFAULT_CORE, options), /did not complete successfully/);
  });
}

test("empty or invalid executable stubs fail before any process starts", () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from("fixture"), Buffer.alloc(80)]) {
    const { calls, options } = fixture({}, bytes);
    assert.throws(() => verifyCore(DEFAULT_CORE, options), /executable header/);
    assert.deepEqual(calls, []);
  }
});

test("truncated PE, wrong architecture, DLL, and missing executable sections fail", () => {
  const truncated = executable(); truncated.writeUInt32LE(truncated.length - 4, 0x3c);
  const x86 = executable(); x86.writeUInt16LE(0x14c, 0x84);
  const dll = executable(); dll.writeUInt16LE(0x2022, 0x96);
  const noSections = executable(); noSections.writeUInt16LE(0, 0x86);
  for (const bytes of [truncated, x86, dll, noSections]) {
    assert.throws(() => validateWindowsExecutable(bytes));
  }
});

test("missing binary and a non-Windows host cannot pass", () => {
  const { calls, options } = fixture();
  assert.throws(() => verifyCore(DEFAULT_CORE, { ...options, readFile: () => { throw new Error("ENOENT"); } }), /missing or unreadable/);
  assert.throws(() => verifyCore(DEFAULT_CORE, { ...options, platform: "linux" }), /must be measured on Windows/);
  assert.deepEqual(calls, []);
});

test("release and bundle hooks check the exact Tauri sidecar, and prerelease exercises the gate", () => {
  const root = path.join(__dirname, "..");
  const conf = JSON.parse(fs.readFileSync(path.join(root, "gui-pro", "src-tauri", "tauri.conf.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "gui-pro", "package.json"), "utf8"));
  assert.deepEqual(conf.bundle.externalBin, ["trusttunnel_client"]);
  assert.equal(path.basename(DEFAULT_CORE), "trusttunnel_client-x86_64-pc-windows-msvc.exe");
  assert.equal(conf.build.beforeBuildCommand, "npm run core:check && npm run build");
  assert.equal(conf.build.beforeBundleCommand, "npm run core:check");
  assert.equal(pkg.scripts["core:check"], "node ../scripts/core-compatibility-gate.cjs");
  assert.equal(pkg.scripts["core:test"], "node ../scripts/core-compatibility-gate.test.cjs");
  assert.ok(pkg.scripts.prerelease.startsWith("npm run core:test && npm run core:check &&"));
});
